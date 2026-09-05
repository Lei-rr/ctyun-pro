import type { AccountConfig } from '../config.js';
import type { Logger } from '../core/logger.js';
import { TaskRunner } from './task-runner.js';
import { RedeemTask } from './redeem.js';
import { sendWebhookNotification } from '../core/utils.js';
import type { AccountManager } from '../core/account-manager.js';

/**
 * 工业级精准时间点调度器
 * 负责各账号每日自动打卡与周期性兑换下单
 */
export class TaskScheduler {
  private accountManager: AccountManager;
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private lastCheckedMinute = '';

  constructor(accountManager: AccountManager, logger: Logger) {
    this.accountManager = accountManager;
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
        // 准点命中判定：仅在到达设定时间的当分钟 (currentHHmm === targetTime) 且今日未执行时触发
        // 若服务重启或时间已过 (currentHHmm > targetTime)，绝不补跑，避免重启误触
        if (tConf.lastRunDate !== today && currentHHmm === targetTime) {
          try {
            this.logger.addLog('info', `[${name}] ⏰ 命中每日做任务定时 (${targetTime})，正在按策略自动执行...`);
            const dId = this.accountManager.getAccountState(name)?.desktops?.[0]?.desktopId;
            const res = await TaskRunner.executeDailyTasks(client, dId, tConf);
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
          this.logger.addLog('info', `[${name}] ${reason}，准备自动下单兑换...`);
          try {
            const targetDesktopId = rConf.targetDesktopId || this.accountManager.getAccountState(name)?.desktops?.[0]?.desktopId;
            if (!targetDesktopId) throw new Error('名下未找到绑定的云电脑');
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
          } catch (err: any) {
            this.logger.addLog('error', `[${name}] 自动兑换失败: ${err.message}`);
            if (this.accountManager.webhookUrl) {
              sendWebhookNotification(
                this.accountManager.webhookUrl,
                `天翼云电脑 - [${name}] 自动兑换异常`,
                `策略: ${reason}\n错误: ${err.message}`,
              ).catch(() => {});
            }
          }
        }
      }
    }
  }
}
