import type { AccountConfig } from '../../config.js';
import { getRandomScheduleTime } from '../../config.js';
import type { Logger } from '../../core/logger.js';
import { TaskRunner } from '../task/index.js';
import { RewardRedeemService } from '../reward/reward-service.js';
import { sendWebhookNotification } from '../../core/utils.js';
import type { ProfileManager } from '../../core/profile-manager.js';

/**
 * 工业级精准时间点调度器
 * 负责各账号每日自动打卡与周期性兑换下单
 */
export class TaskScheduler {
  private profileManager: ProfileManager;
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private lastCheckedMinute = '';
  private lastDigestDate = '';
  private lastMidnightResetDate = '';
  private taskRetryStats = new Map<string, { date: string; attempts: number; nextRetryTime: number }>();
  private redeemRetryStats = new Map<string, { date: string; attempts: number; nextRetryTime: number }>();

  constructor(profileManager: ProfileManager, logger: Logger) {
    this.profileManager = profileManager;
    this.logger = logger;
  }

  public start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.checkTick();
    }, 30000);

    // 启动时立即轻量初检一次
    setTimeout(() => this.checkTick(), 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkTick(): Promise<void> {
    const now = new Date();
    // 强制转为东八区北京时间 (HH:mm)
    const cstStr = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const cstParts = cstStr.split(':');
    const currentHHmm = `${cstParts[0].padStart(2, '0')}:${cstParts[1].padStart(2, '0')}`;
    const currentMinuteKey = `${now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })} ${currentHHmm}`;

    // 同一分钟内只比对一次
    if (this.lastCheckedMinute === currentMinuteKey) return;
    this.lastCheckedMinute = currentMinuteKey;

    const today = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(now)
      .replace(/\//g, '-');

    const [cstYearStr, cstMonthStr, cstDayStr] = today.split('-');
    const cstYear = parseInt(cstYearStr, 10);
    const cstMonth = parseInt(cstMonthStr, 10);
    const cstDay = parseInt(cstDayStr, 10);
    const lastDayOfMonth = new Date(cstYear, cstMonth, 0).getDate();

    // 0. 跨天主动重置今日积分 (0 点清零，纯本地状态机重置，绝不发起多余网络拉取)
    if (this.lastMidnightResetDate && this.lastMidnightResetDate !== today) {
      this.profileManager.resetTodayPointsAtMidnight();
    }
    this.lastMidnightResetDate = today;

    const accounts = this.profileManager.getAllAccounts();

    for (const [name, acc] of accounts.entries()) {
      if (!acc.loginInfo) continue;
      const client = this.profileManager.getClient(name);
      if (!client || !client.loginInfo) continue;

      // 1. 每日自动任务调度 (严格检查 enabled 开关与定时命中)
      const tConf = acc.taskConfig;
      if (!tConf || tConf.enabled === false) {
        // 用户未开启或关闭了每日任务总开关，绝不自动执行
      } else {
        const targetTime = tConf.scheduleTime || getRandomScheduleTime();
        const retryStat = this.taskRetryStats.get(name);
        const nextTime = tConf.retryDate === today ? (tConf.nextRetryTime || retryStat?.nextRetryTime || 0) : (retryStat?.nextRetryTime || 0);
        const isInCooldown = (tConf.retryDate === today || retryStat?.date === today) && Date.now() < nextTime;

        // 准点命中判定：到达或超过设定时间且今日未执行且非退避冷却中时触发 (防止服务重启错过固定当分钟)
        if (!isInCooldown && tConf.lastRunDate !== today && currentHHmm >= targetTime) {
          // 先行锁定今日执行标记，防止抖动异步等待期间重复触发
          tConf.lastRunDate = today;
          acc.taskConfig = tConf;
          this.profileManager.saveToDisk();

          // 仿生随机抖动：引入 3~25 秒阶梯式动态延迟，彻底打散多账号并发特征，防范官方批量风控
          const jitterMs = Math.floor(Math.random() * 22000) + 3000;
          setTimeout(async () => {
            try {
              this.logger.addLog('info', `[${name}] 命中每日做任务定时 (${targetTime}，抖动延时 ${(jitterMs/1000).toFixed(1)}s)，正在按策略自动执行...`);
              const res = await TaskRunner.executeDailyTasks(client, tConf, this.logger);
              acc.lastSignDate = today;
              tConf.lastRunDate = today;
              delete tConf.retryCount;
              delete tConf.retryDate;
              delete tConf.nextRetryTime;
              acc.taskConfig = tConf;
              this.taskRetryStats.delete(name);
              this.profileManager.saveToDisk();
              this.logger.addLog('success', `[${name}] 每日任务已执行: ${res.message}`);

              // 任务完成后异步拉取官方最新积分并刷新看板
              this.profileManager.getPointsAndTasks(name)
                .then(() => this.profileManager.notifyStatusChange())
                .catch(() => {});

              this.profileManager.notifyStatusChange();
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              const isAuthError = /token|expire|登录过期|未登录|auth|401|403|凭证/i.test(errMsg);

              if (isAuthError) {
                // 凭据过期/失效：今日直接标记跳过，禁止高频无效重试，避免轰炸与封号
                tConf.lastRunDate = today;
                delete tConf.retryCount;
                delete tConf.retryDate;
                delete tConf.nextRetryTime;
                acc.taskConfig = tConf;
                this.profileManager.saveToDisk();
                this.taskRetryStats.delete(name);
                this.logger.addLog('warn', `[${name}] 自动任务执行失败（登录凭证已过期/失效，已停止今日重试，请重新登录账号）: ${errMsg}`);
                if (this.profileManager.webhookUrl) {
                  sendWebhookNotification(
                    this.profileManager.webhookUrl,
                    `天翼云电脑 - [${name}] 登录凭证失效`,
                    `自动任务执行失败：登录凭证已过期或失效，已停止今日自动调度，请重新登录账号。\n错误详情: ${errMsg}`,
                  ).catch(() => {});
                }
              } else {
                // 偶发网络异常：引入退避重试（每天最多重试 3 次，每次重试至少退避 15 分钟，状态持久化防重启清零）
                const persistedAttempts = tConf.retryDate === today ? (tConf.retryCount || 0) : 0;
                const memAttempts = this.taskRetryStats.get(name)?.date === today ? (this.taskRetryStats.get(name)?.attempts || 0) : 0;
                const currentAttempts = Math.max(persistedAttempts, memAttempts) + 1;
                const MAX_ATTEMPTS = 3;

                if (currentAttempts >= MAX_ATTEMPTS) {
                  tConf.lastRunDate = today;
                  tConf.retryDate = today;
                  tConf.retryCount = currentAttempts;
                  delete tConf.nextRetryTime;
                  acc.taskConfig = tConf;
                  this.profileManager.saveToDisk();
                  this.taskRetryStats.delete(name);
                  this.logger.addLog('warn', `[${name}] 自动任务执行失败已达今日上限 (${MAX_ATTEMPTS}次)，停止今日自动任务: ${errMsg}`);
                  if (this.profileManager.webhookUrl) {
                    sendWebhookNotification(
                      this.profileManager.webhookUrl,
                      `天翼云电脑 - [${name}] 自动任务重试达上限`,
                      `今日连续重试 ${MAX_ATTEMPTS} 次均失败，停止今日自动调度。\n最后错误: ${errMsg}`,
                    ).catch(() => {});
                  }
                } else {
                  const nextRetryTime = Date.now() + 15 * 60 * 1000;
                  tConf.retryDate = today;
                  tConf.retryCount = currentAttempts;
                  tConf.nextRetryTime = nextRetryTime;
                  tConf.lastRunDate = '';
                  acc.taskConfig = tConf;
                  this.profileManager.saveToDisk();
                  this.taskRetryStats.set(name, { date: today, attempts: currentAttempts, nextRetryTime });
                  this.logger.addLog(
                    'warn',
                    `[${name}] 自动任务执行异常（第 ${currentAttempts}/${MAX_ATTEMPTS} 次，将在 15 分钟后退避重试）: ${errMsg}`,
                  );
                }
              }
            }
          }, jitterMs);
        }
      }

      // 2. 自动兑换策略精准调度 (到达或超过 07:00 且今日未执行时触发，防止容器重启错过整点)
      const rConf = acc.redeemConfig;
      const redeemRetry = this.redeemRetryStats.get(name);
      const isRedeemInBackoff =
        redeemRetry && redeemRetry.date === today && Date.now() < redeemRetry.nextRetryTime;

      if (rConf && rConf.enabled && rConf.lastRedeemDate !== today && currentHHmm >= '07:00' && !isRedeemInBackoff) {
        let shouldRedeem = false;
        let reason = '';

        if (rConf.scheduleType === 'monthly_last_day' || !rConf.scheduleType) {
          if (cstDay === lastDayOfMonth) {
            shouldRedeem = true;
            reason = `命中月末最后一天 (${cstDay}号) 兑换策略（维持8C16G）`;
          }
        } else if (rConf.scheduleType === 'monthly_day') {
          if (cstDay === (rConf.monthlyDay || 28)) {
            shouldRedeem = true;
            reason = `命中每月 ${cstDay} 号兑换策略`;
          }
        } else if (rConf.scheduleType === 'daily') {
          shouldRedeem = true;
          reason = '命中每日兑换策略';
        } else if (rConf.scheduleType === 'specific_date') {
          if (rConf.specificDate === today) {
            shouldRedeem = true;
            reason = `命中指定兑换日期 (${today})`;
          }
        } else if (rConf.scheduleType === 'interval_days') {
          const interval = rConf.intervalDays || 4;
          if (!rConf.lastRedeemDate) {
            shouldRedeem = true;
            reason = '首次执行间隔兑换';
          } else {
            const diffDays = Math.floor(
              (new Date(today).getTime() - new Date(rConf.lastRedeemDate).getTime()) /
                (1000 * 3600 * 24),
            );
            if (diffDays >= interval) {
              shouldRedeem = true;
              reason = `已间隔 ${diffDays} 天，达到设定的 ${interval} 天`;
            }
          }
        }

        if (shouldRedeem) {
          // 仿生抖动：多账号自动兑换引入 1~12 秒离散延迟，避免多账号同一秒向商城并发下单
          const redeemJitterMs = Math.floor(Math.random() * 11000) + 1000;
          await new Promise((r) => setTimeout(r, redeemJitterMs));

          this.logger.addLog('info', `[${name}] ${reason} (仿生延迟 ${(redeemJitterMs/1000).toFixed(1)}s)，准备自动下单兑换...`);
          let targetDesktopId = rConf.targetDesktopId;
          const state = this.profileManager.getAccountState(name);
          if (!targetDesktopId) {
            targetDesktopId = state?.desktops?.[0]?.desktopId;
          } else {
            // 兼容配置中存储的是 desktopCode，反查底层数字 desktopId
            const matched = state?.desktops?.find(
              (d) => d.desktopCode === targetDesktopId || String(d.desktopId) === String(targetDesktopId),
            );
            if (matched) {
              targetDesktopId = matched.desktopId;
            } else {
              const fallbackFound = this.profileManager.findDesktopByCode(targetDesktopId);
              if (fallbackFound) {
                targetDesktopId = fallbackFound.desktop.desktopId;
              }
            }
          }
          if (!targetDesktopId) {
            this.logger.addLog('warn', `[${name}] 自动兑换跳过: 名下未找到绑定的云电脑`);
            continue;
          }

          let redeemSuccess = false;
          let lastRedeemMsg = '';
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              if (attempt > 1) {
                this.logger.addLog('info', `[${name}] 正在进行第 ${attempt}/3 次自动兑换重试...`);
                await new Promise((r) => setTimeout(r, 3000));
              }
              const res = await RewardRedeemService.placeOrder(
                client,
                targetDesktopId,
                rConf.targetProdId,
                rConf.costPoints,
                rConf.prodType,
              );
              rConf.lastRedeemDate = today;
              this.profileManager.saveToDisk();
              this.logger.addLog('success', `[${name}] 自动兑换成功: ${res.message}`);
              if (this.profileManager.webhookUrl) {
                sendWebhookNotification(
                  this.profileManager.webhookUrl,
                  `天翼云电脑 - [${name}] 自动兑换成功`,
                  `策略触发: ${reason}\n兑换结果: ${res.message}`,
                ).catch(() => {});
              }
              redeemSuccess = true;
              this.redeemRetryStats.delete(name);
              break;
            } catch (e) {
              lastRedeemMsg = e instanceof Error ? e.message : String(e);
              // 若官方明确返回积分不足，重试无法解决，直接终止重试，避免刷屏与无谓请求
              const isInsufficientPoints =
                lastRedeemMsg.includes('积分不足') ||
                lastRedeemMsg.includes('点数不足') ||
                lastRedeemMsg.includes('余额不足');
              // 若触发官方风控拦截、操作过于频繁等，立即熔断阻断重试，保护账号安全
              const isRiskLimited =
                lastRedeemMsg.includes('风控') ||
                lastRedeemMsg.includes('频繁') ||
                lastRedeemMsg.includes('异常') ||
                lastRedeemMsg.includes('限制');
              if (isInsufficientPoints || isRiskLimited) {
                this.logger.addLog('warn', `[${name}] 自动兑换终止: ${lastRedeemMsg}，触发保护终止重试`);
                // 积分不足或风控属于当日业务终态，锁定当日标记并清除重试状态
                rConf.lastRedeemDate = today;
                this.profileManager.saveToDisk();
                this.redeemRetryStats.delete(name);
                break;
              }
              this.logger.addLog('warn', `[${name}] 第 ${attempt} 次自动兑换未成功: ${lastRedeemMsg}`);
            }
          }

          if (!redeemSuccess) {
            const isInsufficientPoints =
              lastRedeemMsg.includes('积分不足') ||
              lastRedeemMsg.includes('点数不足') ||
              lastRedeemMsg.includes('余额不足');
            const isRiskLimited =
              lastRedeemMsg.includes('风控') ||
              lastRedeemMsg.includes('频繁') ||
              lastRedeemMsg.includes('异常') ||
              lastRedeemMsg.includes('限制');

            if (isInsufficientPoints || isRiskLimited) {
              const failTitle = isInsufficientPoints
                ? `[${name}] 自动兑换跳过: 积分不足`
                : `[${name}] 自动兑换跳过: 触发安全风控保护`;
              this.logger.addLog('error', failTitle);
              // 积分不足属于预期内正常积累状态，不发送 Webhook 骚扰；触发安全风控时推送安全告警
              if (isRiskLimited && this.profileManager.webhookUrl) {
                sendWebhookNotification(
                  this.profileManager.webhookUrl,
                  `天翼云电脑 - [${name}] 自动兑换触发风控保护`,
                  `策略触发: ${reason}\n状态: 已熔断当日兑换以保护账号\n官方原因: ${lastRedeemMsg}`,
                ).catch(() => {});
              }
            } else {
              // 临时网络或服务异常：引入 15 分钟跨周期退避重试（当日上限 3 轮）
              const memAttempts =
                this.redeemRetryStats.get(name)?.date === today
                  ? this.redeemRetryStats.get(name)?.attempts || 0
                  : 0;
              const currentAttempts = memAttempts + 1;
              const MAX_REDEEM_ROUNDS = 3;

              if (currentAttempts >= MAX_REDEEM_ROUNDS) {
                this.redeemRetryStats.delete(name);
                rConf.lastRedeemDate = today;
                this.profileManager.saveToDisk();
                this.logger.addLog(
                  'error',
                  `[${name}] 自动兑换退避重试已达上限 (${MAX_REDEEM_ROUNDS} 轮)，停止今日自动兑换调度: ${lastRedeemMsg}`,
                );
                if (this.profileManager.webhookUrl) {
                  sendWebhookNotification(
                    this.profileManager.webhookUrl,
                    `天翼云电脑 - [${name}] 自动兑换失败达上限`,
                    `策略触发: ${reason}\n今日连续重试 ${MAX_REDEEM_ROUNDS} 轮均遭遇异常，已停止今日调度。\n最后错误: ${lastRedeemMsg}`,
                  ).catch(() => {});
                }
              } else {
                const nextRetryTime = Date.now() + 15 * 60 * 1000;
                this.redeemRetryStats.set(name, {
                  date: today,
                  attempts: currentAttempts,
                  nextRetryTime,
                });
                this.logger.addLog(
                  'warn',
                  `[${name}] 自动兑换遭遇临时异常（第 ${currentAttempts}/${MAX_REDEEM_ROUNDS} 轮，将在 15 分钟后退避重试）: ${lastRedeemMsg}`,
                );
              }
            }
          }
        }
      }
    }

    // 3. 每日早报汇总推送 (Daily Digest，固定在每日 09:00 推送一条汇总通知)
    if (this.profileManager.webhookUrl && this.lastDigestDate !== today && currentHHmm === '09:00') {
      this.lastDigestDate = today;
      try {
        const reportLines: string[] = [];
        let totalGeneral = 0;
        let onlineCount = 0;

        for (const [name, acc] of accounts.entries()) {
          const state = this.profileManager.getAccountState(name);
          const isOnline = state?.status === 'online';
          if (isOnline) onlineCount++;

          let pointInfo = '';
          try {
            const sum = await this.profileManager.getPointsAndTasks(name);
            const total = (sum.generalPoints || 0) + (sum.phonePoints || 0);
            totalGeneral += total;
            pointInfo = `总积分: ${total}`;
          } catch {
            pointInfo = '积分查询暂缓';
          }

          const signMark = acc.lastSignDate === today ? '已打卡' : '待执行';
          const statusText = isOnline ? '[在线]' : '[离线]';
          reportLines.push(`${statusText} [${name}]: ${signMark} | ${pointInfo}`);
        }

        const title = `CTYUN-PRO - 每日运行早报 (${today})`;
        const content = `今日监控概览：\n• 在线账号: ${onlineCount}/${accounts.size}\n• 总积分池: ${totalGeneral} 积分\n• 报告时间: ${currentHHmm}\n\n账号明细：\n${reportLines.join('\n')}\n\n系统已全自动维持保活长连接中。`;
        sendWebhookNotification(this.profileManager.webhookUrl, title, content).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.addLog('warn', `每日早报推送异常: ${msg}`);
      }
    }
  }
}
