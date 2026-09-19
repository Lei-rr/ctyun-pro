import type { CtYunClient } from '../../ctyun/client.js';
import { errorText } from '../../infra/http.js';
import { getCstDateString } from '../../infra/time.js';
import type { Logger } from '../../infra/logger.js';
import type { AccountConfig, RedeemConfig } from '../../config.js';
import type { ManagedAccount, ManagedDesktopState } from '../../types.js';
import { AiChatTask } from './ai-chat.js';
import { PointsTask, isDailyTask, TASK_STATUS, type PointsSummary } from './points.js';
import { RewardRedeemService, DEFAULT_LOCAL_REWARDS, type RewardItem } from '../reward/service.js';

/** 任务与积分业务对外依赖 (由 ProfileManager 注入，避免循环引用) */
export interface TasksHost {
  logger: Logger;
  rewardsCache: RewardItem[];
  rewardsCacheUpdatedAt: number;
  getAccountNames(): string[];
  setRewardsCache(items: RewardItem[]): void;
  getClient(accountName: string): CtYunClient;
  getAccount(accountName: string): AccountConfig | undefined;
  getAccountState(accountName: string): ManagedAccount | undefined;
  findDesktopByCode(code: string): { accountName: string; desktop: ManagedDesktopState } | undefined;
  reloadDesktops(accountName: string): Promise<void>;
  saveToDisk(): void;
  notifyStatusChange(): void;
  cacheTodayPoints(accountName: string, points: number, date: string, summary: PointsSummary): void;
  setTodayPoints(accountName: string, points: number): void;
}

const REWARDS_CACHE_TTL_MS = 6 * 3600 * 1000;

/**
 * 积分任务、AI 对话与积分兑换业务服务
 * 承载原 ProfileManager 中的任务/奖励逻辑，降低顶层门面复杂度
 */
export class TasksService {
  constructor(private host: TasksHost) {}

  /** 手动执行 AI 对话任务 */
  public async runAiChat(accountName: string): Promise<string> {
    const acc = this.host.getAccount(accountName);
    const client = this.host.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法执行AI对话');
    }
    const res = await AiChatTask.execute(client);
    this.host.logger.addLog('success', `AI 对话: ${res.message}`, { account: accountName });
    setTimeout(() => {
      this.getPointsAndTasks(accountName)
        .then(() => this.host.notifyStatusChange())
        .catch(() => {});
    }, 2000);
    return res.message;
  }

  /** 查询积分收支明细 */
  public async getPointDetailList(
    accountName: string,
    options: { pageNum?: number; pageSize?: number; msgType?: number } = {},
  ) {
    const client = this.host.getClient(accountName);
    if (!client.loginInfo) {
      throw new Error('账号未登录，无法查询积分明细');
    }
    return PointsTask.getPointDetailList(client, options);
  }

  /** 手动兑换指定商品 */
  public async redeem(
    accountName: string,
    prodId?: number,
    costPoints?: number,
    prodType?: string,
    desktopId?: string,
    options: { costPointType?: number; count?: number; mobilephone?: string } = {},
  ): Promise<string> {
    const acc = this.host.getAccount(accountName);
    const client = this.host.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法兑换');
    }

    const rConf: RedeemConfig = {
      enabled: acc.redeemConfig?.enabled ?? false,
      scheduleType: acc.redeemConfig?.scheduleType ?? 'interval_days',
      ...acc.redeemConfig,
    };

    let targetDesktopId = desktopId || rConf.targetDesktopId;
    let state = this.host.getAccountState(accountName);
    if ((!state?.desktops || state.desktops.length === 0) && (!targetDesktopId || targetDesktopId === 'undefined')) {
      try {
        await this.host.reloadDesktops(accountName);
        state = this.host.getAccountState(accountName);
      } catch {}
    }

    if (!targetDesktopId) {
      targetDesktopId = state?.desktops?.[0]?.desktopId;
    } else {
      const matched = state?.desktops?.find(
        (d) => d.desktopCode === targetDesktopId || String(d.desktopId) === String(targetDesktopId),
      );
      if (matched) {
        targetDesktopId = matched.desktopId;
      } else {
        const fallback = this.host.findDesktopByCode(targetDesktopId);
        if (fallback) targetDesktopId = fallback.desktop.desktopId;
      }
    }

    const finalProdId = prodId || rConf.targetProdId;
    const resolved = await RewardRedeemService.resolveReward(client, finalProdId, this.host.rewardsCache);

    const res = await RewardRedeemService.placeOrder(
      client,
      targetDesktopId,
      finalProdId,
      costPoints || rConf.costPoints,
      prodType || rConf.prodType,
      { ...options, costPointType: options.costPointType ?? resolved?.costPointType },
      resolved,
    );

    rConf.lastRedeemDate = getCstDateString();
    acc.redeemConfig = rConf;
    this.host.saveToDisk();

    // 升配/扩容类商品：官方要求兑换后立即重启云电脑方可生效
    let restartNote = '';
    if (resolved?.hardwareBound && targetDesktopId) {
      try {
        const hit = this.host.findDesktopByCode(String(targetDesktopId));
        const desktopCode = hit?.desktop?.desktopCode || String(targetDesktopId);
        const apiDesktopId = hit?.desktop?.desktopId || String(targetDesktopId);
        await client.operateDesktop(String(apiDesktopId), 'reset', hit?.desktop?.objType ?? 0);
        restartNote = '，已下发重启指令使权益生效';
        this.host.logger.addLog('info', '升配/扩容生效重启指令已下发', { account: accountName, desktop: desktopCode });
      } catch (err) {
        const msg = errorText(err);
        restartNote = `；重启指令下发失败(请手动重启生效): ${msg}`;
        this.host.logger.addLog('warn', `兑换后自动重启失败: ${msg}`, { account: accountName });
      }
    }

    this.host.logger.addLog('success', res.message, { account: accountName });
    return `${res.message}${restartNote}`;
  }

  /** 获取积分商城商品目录 (纯内存缓存，6 小时 TTL) */
  public async getAvailableRewards(accountName?: string, forceRefresh = false): Promise<RewardItem[]> {
    const cache = this.host.rewardsCache;
    const targetAccount =
      accountName || this.host.getAccountNames().find((k) => !!this.host.getClient(k).loginInfo);

    const isStale = Date.now() - this.host.rewardsCacheUpdatedAt > REWARDS_CACHE_TTL_MS;
    if (targetAccount && (forceRefresh || cache.length === 0 || isStale)) {
      try {
        const client = this.host.getClient(targetAccount);
        if (client?.loginInfo) {
          const fetched = await RewardRedeemService.getAvailableRewards(client);
          if (fetched.length > 0) {
            this.host.setRewardsCache(fetched);
          }
        }
      } catch (err) {
        this.host.logger.addLog('warn', `获取在线商品列表失败，回退内存缓存: ${errorText(err)}`, {});
      }
    }
    const current = this.host.rewardsCache;
    return current.length > 0 ? current : DEFAULT_LOCAL_REWARDS;
  }

  /** 查询积分与任务，并同步今日已获积分缓存 */
  public async getPointsAndTasks(accountName: string): Promise<PointsSummary> {
    const client = this.host.getClient(accountName);
    const summary = await PointsTask.getPointsAndTasks(client);

    let todayEarned = 0;
    for (const t of summary.tasks) {
      if (t.status === TASK_STATUS.DONE && isDailyTask(t)) {
        todayEarned += Number(t.rewardPoints || 0);
      }
    }

    const todayStr = getCstDateString();
    this.host.cacheTodayPoints(accountName, todayEarned, todayStr, summary);
    this.host.setTodayPoints(accountName, todayEarned);

    // 官方显示对话任务已达成时同步 lastRunDate，防止调度器误判补跑
    const acc = this.host.getAccount(accountName);
    if (acc?.taskConfig) {
      const chatTask = summary.tasks.find((t) => t.type === 'chat');
      const isChatDone =
        !chatTask || chatTask.status === TASK_STATUS.DONE || chatTask.status === TASK_STATUS.UNCLAIMED;
      if (isChatDone && acc.taskConfig.lastRunDate !== todayStr) {
        acc.taskConfig.lastRunDate = todayStr;
        this.host.saveToDisk();
      }
    }

    return summary;
  }

}
