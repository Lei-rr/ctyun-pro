import type { AccountConfig } from '../config.js';
import type { Logger } from '../core/logger.js';
import { TaskRunner } from './task-runner.js';
import { RedeemTask } from './redeem.js';
import { sendWebhookNotification } from '../core/utils.js';
import type { ProfileManager } from '../core/profile-manager.js';

/**
 * 工业级精准时间点调度器
 * 负责各账号每日自动打卡与周期性兑换下单
 */
export class TaskScheduler {
  private accountManager: ProfileManager;
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private lastCheckedMinute = '';
  private lastDigestDate = '';
  private lastMidnightResetDate = '';

  constructor(profileManager: ProfileManager, logger: Logger) {
    this.accountManager = profileManager;
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

    const cstDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const cstDay = cstDate.getDate();
    const cstMonth = cstDate.getMonth() + 1;
    const cstYear = cstDate.getFullYear();
    const lastDayOfMonth = new Date(cstYear, cstMonth, 0).getDate();

    // 0. 跨天主动重置今日积分 (0 点清零，纯本地状态机重置，绝不发起多余网络拉取)
    if (this.lastMidnightResetDate && this.lastMidnightResetDate !== today) {
      this.accountManager.resetTodayPointsAtMidnight();
    }
    this.lastMidnightResetDate = today;

    const accounts = this.accountManager.getAllAccounts();

    for (const [name, acc] of accounts.entries()) {
      if (!acc.loginInfo) continue;
      const client = this.accountManager.getClient(name);
      if (!client || !client.loginInfo) continue;

      // 1. 每日自动任务调度 (严格检查 enabled 开关与定时命中)
      const tConf = acc.taskConfig;
      if (!tConf || tConf.enabled === false) {
        // 用户未开启或关闭了每日任务总开关，绝不自动执行
      } else {
        const targetTime = tConf.scheduleTime || '03:30';
        // 准点命中判定：到达或超过设定时间且今日未执行时触发 (防止服务重启错过固定当分钟)
        if (tConf.lastRunDate !== today && currentHHmm >= targetTime) {
          // 先行锁定今日执行标记，防止抖动异步等待期间重复触发
          tConf.lastRunDate = today;
          acc.taskConfig = tConf;
          this.accountManager.saveToDisk();

          // 仿生随机抖动：引入 3~25 秒阶梯式动态延迟，彻底打散多账号并发特征，防范官方批量风控
          const jitterMs = Math.floor(Math.random() * 22000) + 3000;
          setTimeout(async () => {
            try {
              this.logger.addLog('info', `[${name}] 命中每日做任务定时 (${targetTime}，抖动延时 ${(jitterMs/1000).toFixed(1)}s)，正在按策略自动执行...`);
              const dId = this.accountManager.getAccountState(name)?.desktops?.[0]?.desktopId;
              const res = await TaskRunner.executeDailyTasks(client, dId, tConf, this.logger);
              acc.lastSignDate = today;
              tConf.lastRunDate = today;
              acc.taskConfig = tConf;
              this.accountManager.saveToDisk();
              this.logger.addLog('success', `[${name}] 每日任务已执行: ${res.message}`);

              // Webhook 通知
              if (this.accountManager.webhookUrl) {
                sendWebhookNotification(
                  this.accountManager.webhookUrl,
                  `天翼云电脑 - [${name}] 每日任务完成`,
                  `执行时间: ${targetTime}\n任务详情: ${res.message}`,
                ).catch(() => {});
              }

              // 若开启了使用1小时挂机任务，自动连带触发智能补足时长挂机
              if (tConf.keepAliveHang !== false) {
                this.accountManager.manualHang(name).catch(() => {});
              }

              // 任务完成后异步拉取官方最新积分并刷新看板
              this.accountManager.getPointsAndTasks(name)
                .then(() => this.accountManager.notifyStatusChange())
                .catch(() => {});

              this.accountManager.notifyStatusChange();
            } catch (e: any) {
              this.logger.addLog('warn', `[${name}] 自动任务执行跳过: ${e.message}`);
              if (this.accountManager.webhookUrl) {
                sendWebhookNotification(
                  this.accountManager.webhookUrl,
                  `天翼云电脑 - [${name}] 任务执行跳过`,
                  `原因: ${e.message}`,
                ).catch(() => {});
              }
            }
          }, jitterMs);
        }
      }

      // 2. 自动兑换策略精准调度 (准点在 07:00 执行)
      const rConf = acc.redeemConfig;
      if (rConf && rConf.enabled && rConf.lastRedeemDate !== today && currentHHmm === '07:00') {
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
          const interval = rConf.intervalDays || 30;
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
          const targetDesktopId = rConf.targetDesktopId || this.accountManager.getAccountState(name)?.desktops?.[0]?.desktopId;
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
              const res = await RedeemTask.placeOrder(
                client,
                targetDesktopId,
                rConf.targetProdId,
                rConf.costPoints,
                rConf.prodType,
              );
              rConf.lastRedeemDate = today;
              this.accountManager.saveToDisk();
              this.logger.addLog('success', `[${name}] 自动兑换成功: ${res.message}`);
              if (this.accountManager.webhookUrl) {
                sendWebhookNotification(
                  this.accountManager.webhookUrl,
                  `天翼云电脑 - [${name}] 自动兑换成功`,
                  `策略触发: ${reason}\n兑换结果: ${res.message}`,
                ).catch(() => {});
              }
              redeemSuccess = true;
              break;
            } catch (e: any) {
              lastRedeemMsg = e.message;
              // 若官方明确返回积分不足，重试无法解决，直接终止重试，避免刷屏与无谓请求
              const isInsufficientPoints =
                lastRedeemMsg.includes('积分不足') ||
                lastRedeemMsg.includes('点数不足') ||
                lastRedeemMsg.includes('余额不足');
              if (isInsufficientPoints) {
                this.logger.addLog('warn', `[${name}] 自动兑换失败: ${lastRedeemMsg}，无需重试`);
                break;
              }
              this.logger.addLog('warn', `[${name}] 第 ${attempt} 次自动兑换未成功: ${e.message}`);
            }
          }

          if (!redeemSuccess) {
            const isInsufficientPoints =
              lastRedeemMsg.includes('积分不足') ||
              lastRedeemMsg.includes('点数不足') ||
              lastRedeemMsg.includes('余额不足');
            const failTitle = isInsufficientPoints
              ? `[${name}] 自动兑换跳过: 积分不足`
              : `[${name}] 自动兑换失败（重试3次）: ${lastRedeemMsg}`;
            this.logger.addLog('error', failTitle);
            if (this.accountManager.webhookUrl) {
              sendWebhookNotification(
                this.accountManager.webhookUrl,
                `天翼云电脑 - [${name}] 自动兑换未达成`,
                `策略触发: ${reason}\n原因: ${lastRedeemMsg}`,
              ).catch(() => {});
            }
          }
        }
      }
    }

    // 3. 每日早报汇总推送 (Daily Digest，固定在每日 09:00 推送一条汇总通知)
    if (this.accountManager.webhookUrl && this.lastDigestDate !== today && currentHHmm === '09:00') {
      this.lastDigestDate = today;
      try {
        const reportLines: string[] = [];
        let totalGeneral = 0;
        let onlineCount = 0;

        for (const [name, acc] of accounts.entries()) {
          const state = this.accountManager.getAccountState(name);
          const isOnline = state?.status === 'online';
          if (isOnline) onlineCount++;

          let pointInfo = '';
          try {
            const sum = await this.accountManager.getPointsAndTasks(name);
            const total = (sum.generalPoints || 0) + (sum.phonePoints || 0);
            totalGeneral += total;
            const hangTask = sum.tasks.find((t) => t.name.includes('使用1小时') || t.name.includes('使用'));
            const hangStatusText = hangTask?.isCompleted ? '已达标(100分)' : `${hangTask?.currentProgress || 0}秒`;
            pointInfo = `总积分: ${total} | 挂机: ${hangStatusText}`;
          } catch {
            pointInfo = '积分查询暂缓';
          }

          const signMark = acc.lastSignDate === today ? '已打卡' : '待执行';
          const statusIcon = isOnline ? '🟢' : '🔴';
          reportLines.push(`${statusIcon} [${name}]: ${signMark} | ${pointInfo}`);
        }

        const title = `CTYUN-PRO - 每日运行早报 (${today})`;
        const content = `今日监控概览：\n• 在线账号: ${onlineCount}/${accounts.size}\n• 总积分池: ${totalGeneral} 积分\n• 报告时间: ${currentHHmm}\n\n账号明细：\n${reportLines.join('\n')}\n\n系统已全自动维持保活长连接中。`;
        sendWebhookNotification(this.accountManager.webhookUrl, title, content).catch(() => {});
      } catch (err: any) {
        this.logger.addLog('warn', `每日早报推送异常: ${err.message}`);
      }
    }
  }
}
