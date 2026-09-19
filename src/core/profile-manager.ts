import {
  normalizeUseStatusText,
  type CtYunClient,
  type Desktop,
  type LoginInfo,
  type PowerOperation,
} from '../ctyun/client.js';
import { KeepaliveService } from '../services/keepalive/service.js';
import { WatchdogService } from '../services/watchdog/service.js';
import { Logger, type LogItem } from '../infra/logger.js';
import type { PointsSummary } from '../services/tasks/points.js';
import { TaskScheduler } from '../services/tasks/scheduler.js';
import { TasksService } from '../services/tasks/service.js';
import type { RewardItem } from '../services/reward/service.js';
import { errorText } from '../infra/http.js';
import { getCstDateString } from '../infra/time.js';
import { NotifyService } from '../infra/notify.js';
import { WebActiveTracker } from '../services/desktop/web-active.js';
import { DesktopPowerTracker } from '../services/desktop/power-tracker.js';
import { AccountStore } from './account-store.js';
import { DesktopResolver } from './desktop-resolver.js';
import type { AccountConfig } from '../config.js';
import type { ManagedAccount, ManagedDesktopState } from '../types.js';

export { type ManagedAccount } from '../types.js';

/** 官方桌面数据 → 托管态 (保留既有运行状态与心跳) */
function mergeDesktopState(d: Desktop, old?: ManagedDesktopState): ManagedDesktopState {
  return {
    desktopId: d.desktopId,
    desktopName: d.desktopName,
    desktopCode: d.desktopCode,
    useStatusText: d.useStatusText,
    objType: d.objType,
    objId: d.objId || d.poolId,
    poolId: d.poolId,
    isPool: d.isPool,
    connectMaster: d.connectMaster,
    connectUrl: d.connectUrl,
    backupurl: d.backupurl,
    imageName: d.imageName || '',
    flavorName: d.flavorName || d.desktopName || '',
    status: old?.status || 'idle',
    lastHeartbeat: typeof old?.lastHeartbeat === 'string' ? old.lastHeartbeat : undefined,
  };
}

/** 托管态 → 持久化快照 (剔除瞬时运行状态) */
function toPersistedDesktop(d: ManagedDesktopState): ManagedDesktopState {
  return {
    desktopId: d.desktopId,
    desktopName: d.desktopName,
    desktopCode: d.desktopCode,
    useStatusText: d.useStatusText,
    objType: d.objType,
    objId: d.objId,
    poolId: d.poolId,
    isPool: d.isPool,
    connectMaster: d.connectMaster,
    connectUrl: d.connectUrl,
    backupurl: d.backupurl,
    imageName: d.imageName,
    flavorName: d.flavorName,
    status: d.status,
    lastHeartbeat: d.lastHeartbeat,
  };
}

/**
 * 账号与系统顶层业务门面
 * 组合 AccountStore(数据) + DesktopResolver(寻址) + 保活/看门狗/任务/电源/避让服务
 */
export class ProfileManager {
  private readonly store = new AccountStore();
  private readonly resolver = new DesktopResolver({
    iterateStates: () => this.store.states.entries(),
    iterateConfiguredDesktops: () =>
      (function* (accounts: Map<string, AccountConfig>) {
        for (const [name, acc] of accounts.entries()) yield [name, acc.desktops || []] as [string, Array<{ desktopCode?: string; desktopId?: string }>];
      })(this.store.accounts),
    reloadDesktops: (name) => this.reloadDesktops(name),
    getAccountNames: () => Array.from(this.store.accounts.keys()),
    getState: (name) => this.store.states.get(name),
  });

  private logger = new Logger();
  private keepaliveService: KeepaliveService;
  private watchdogService: WatchdogService;
  private taskScheduler: TaskScheduler;
  private statusListeners: Set<() => void> = new Set();
  private expiredNotifiedAccounts: Set<string> = new Set();
  private manualShutdownDesktops: Set<string> = new Set();
  private reloadDesktopsPromises: Map<string, Promise<void>> = new Map();

  private webActiveTracker = new WebActiveTracker();
  private powerTracker: DesktopPowerTracker;
  private tasksService: TasksService;

  public get adminPassword(): string {
    return this.store.adminPassword;
  }
  public set adminPassword(v: string) {
    this.store.adminPassword = v;
  }

  public get webhookUrl(): string {
    return this.store.webhookUrl;
  }
  public set webhookUrl(v: string) {
    this.store.webhookUrl = v;
  }

  public get rewardsCache(): RewardItem[] {
    return this.store.rewardsCache;
  }

  constructor() {
    this.keepaliveService = new KeepaliveService(this.logger, () => this.notifyStatusChange());
    this.watchdogService = new WatchdogService({ profileManager: this, logger: this.logger });
    this.taskScheduler = new TaskScheduler(this, this.logger);

    const store = this.store;
    this.tasksService = new TasksService({
      logger: this.logger,
      get rewardsCache() {
        return store.rewardsCache;
      },
      get rewardsCacheUpdatedAt() {
        return store.rewardsCacheUpdatedAt;
      },
      getAccountNames: () => Array.from(store.accounts.keys()),
      setRewardsCache: (items) => store.setRewardsCache(items),
      getClient: (name) => this.getClient(name),
      getAccount: (name) => store.accounts.get(name),
      getAccountState: (name) => store.states.get(name),
      findDesktopByCode: (code) => this.findDesktopByCode(code),
      reloadDesktops: (name) => this.reloadDesktops(name),
      saveToDisk: () => this.saveToDisk(),
      notifyStatusChange: () => this.notifyStatusChange(),
      cacheTodayPoints: (name, points, date, summary) => {
        store.todayPointsCache.set(name, { todayPoints: points, date, summary, updatedAt: Date.now() });
      },
      setTodayPoints: (name, points) => {
        const st = store.states.get(name);
        if (st) st.todayPoints = points;
      },
    });

    this.powerTracker = new DesktopPowerTracker(this.logger, {
      getClient: (name) => this.getClient(name),
      hasAccount: (name) => store.accounts.has(name),
      getDesktopState: (name, dId) => {
        const state = store.states.get(name);
        return state?.desktops.find((d) => String(d.desktopCode) === String(dId) || String(d.desktopId) === String(dId));
      },
      notifyStatusChange: () => this.notifyStatusChange(),
      onPowerOnSuccess: (name) => {
        setTimeout(() => this.reloadDesktops(name).catch(() => {}), 2000);
      },
      onPowerTimeout: (name) => {
        this.reloadDesktops(name).catch(() => {});
      },
    });

    this.loadFromDisk();
    this.taskScheduler.start();

    // 让位事件 → 启动自愈看门狗探针
    this.keepaliveService.on('desktop:paused', ({ accountName, desktopId }) => {
      this.watchdogService.startWatchdog(accountName, desktopId);
    });
  }

  public getWatchdogService(): WatchdogService {
    return this.watchdogService;
  }

  public getKeepaliveService(): KeepaliveService {
    return this.keepaliveService;
  }

  public findDesktopByCode(desktopCode: string) {
    return this.resolver.find(desktopCode);
  }

  public async resolveDesktop(desktopCode: string, accountHint?: string) {
    return this.resolver.resolve(desktopCode, accountHint);
  }

  public touchWebUserActive(accountName: string, desktopCode: string, durationSec: number = 300): void {
    const matched = this.findDesktopByCode(desktopCode);
    const matchedAccount = accountName || matched?.accountName;
    if (!matchedAccount) return;

    const canonicalKey = matched?.desktop?.desktopCode || desktopCode;
    const pauseAll = () => {
      // desktopCode 与数字 desktopId 双寻址，保活与探针需按两种标识逐一停止
      this.keepaliveService.pauseWorkerForDesktop(matchedAccount, canonicalKey);
      if (matched?.desktop?.desktopId) {
        this.keepaliveService.pauseWorkerForDesktop(matchedAccount, String(matched.desktop.desktopId));
      }
      this.watchdogService.stopWatchdog(matchedAccount, canonicalKey);
      const matchedId = matched?.desktop?.desktopId || canonicalKey;
      this.watchdogService.stopWatchdog(matchedAccount, String(matchedId));
      if (matched?.desktop?.desktopCode) {
        this.watchdogService.stopWatchdog(matchedAccount, String(matched.desktop.desktopCode));
      }
    };
    const resume = () => {
      this.resumeDesktopKeepalive(matchedAccount, canonicalKey).catch(() => {});
    };

    this.webActiveTracker.touchWebActive(canonicalKey, pauseAll, durationSec, resume);
    this.notifyStatusChange();
  }

  /**
   * 恢复指定桌面的保活；Worker 已被移除时回退为整账号重新同步，确保必然恢复
   */
  private async resumeDesktopKeepalive(accountName: string, desktopCode: string): Promise<void> {
    const acc = this.store.accounts.get(accountName);
    if (!acc || acc.autoStart === false) return;
    const resumed = await this.keepaliveService.resumeWorkerForDesktop(accountName, desktopCode);
    if (!resumed) {
      this.logger.addLog('info', `[${accountName}] 前台操作结束，保活 Worker 不存在，正在重新同步建立...`);
      await this.reloadDesktops(accountName);
    }
  }

  public releaseWebUserActive(accountName: string, desktopCode: string, delaySec: number = 20): void {
    const matched = this.findDesktopByCode(desktopCode);
    const matchedAccount = accountName || matched?.accountName;
    if (!matchedAccount) return;

    const canonicalKey = matched?.desktop?.desktopCode || desktopCode;
    this.webActiveTracker.releaseWebActive(canonicalKey, delaySec, async () => {
      await this.resumeDesktopKeepalive(matchedAccount, canonicalKey);
      this.notifyStatusChange();
    });
  }

  public isWebUserActive(desktopCode: string): boolean {
    const matched = this.findDesktopByCode(desktopCode);
    const canonicalKey = matched?.desktop?.desktopCode || desktopCode;
    return this.webActiveTracker.isWebActive(canonicalKey);
  }

  public isManualShutdown(desktopCode: string): boolean {
    return this.manualShutdownDesktops.has(desktopCode);
  }

  public setManualShutdown(desktopCode: string, manual: boolean): void {
    if (manual) this.manualShutdownDesktops.add(desktopCode);
    else this.manualShutdownDesktops.delete(desktopCode);
  }

  public async renameDesktop(desktopCode: string, newNickName: string): Promise<boolean> {
    const trimmed = (newNickName || '').trim();
    if (!trimmed) throw new Error('云电脑名称不能为空');

    const matched = this.findDesktopByCode(desktopCode);
    if (!matched) throw new Error('未找到指定云电脑');

    const { accountName, desktop } = matched;
    const client = this.getClient(accountName);
    if (!client.loginInfo) throw new Error(`账号 [${accountName}] 未登录`);

    const dId = String(desktop.desktopId || desktop.desktopCode);
    const oldName = desktop.desktopName || desktop.desktopCode;

    await client.modifyDesktopNickName(dId, trimmed);

    desktop.desktopName = trimmed;
    const state = this.store.states.get(accountName);
    const target = state?.desktops.find((d) => String(d.desktopCode) === String(desktopCode) || String(d.desktopId) === dId);
    if (target) target.desktopName = trimmed;

    const acc = this.store.accounts.get(accountName);
    const targetConfig = acc?.desktops?.find((d) => String(d.desktopCode) === String(desktopCode) || String(d.desktopId) === dId);
    if (targetConfig) targetConfig.desktopName = trimmed;

    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${accountName} - ${trimmed}] 云电脑名称已成功修改为 [${trimmed}] (原名: [${oldName}])`);
    return true;
  }

  // ---- 日志与状态订阅 ----

  public addLog(level: 'info' | 'warn' | 'error' | 'success', message: string): void {
    this.logger.addLog(level, message);
  }

  public getRecentLogs(): LogItem[] {
    return this.logger.getRecentLogs();
  }

  public clearLogs(): void {
    this.logger.clearLogs();
  }

  public subscribeLogs(listener: (log: LogItem) => void): () => void {
    return this.logger.subscribe(listener);
  }

  public subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public notifyStatusChange(): void {
    for (const listener of this.statusListeners) {
      try {
        listener();
      } catch {}
    }
  }

  // ---- 账号数据访问 ----

  public getAllAccounts(): Map<string, AccountConfig> {
    return this.store.getAllAccounts();
  }

  public getAccount(keyOrId: string): AccountConfig | undefined {
    return this.store.getAccount(keyOrId);
  }

  public getClient(keyOrId: string): CtYunClient {
    return this.store.getClient(keyOrId);
  }

  public getAccountState(keyOrId: string): ManagedAccount | undefined {
    return this.store.getAccountState(keyOrId);
  }

  public sanitizeLoginInfo(info?: LoginInfo): LoginInfo | undefined {
    return this.store.sanitizeLoginInfo(info);
  }

  public sanitizeAccount(accountOrState: ManagedAccount | AccountConfig): ManagedAccount;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined {
    return this.store.sanitizeAccount(accountOrState);
  }

  /**
   * 对外账号摘要：同步最新配置、计算今日积分，并附加探针/避让运行态
   */
  public getAccountsSummary(): ManagedAccount[] {
    const store = this.store;
    for (const [name, acc] of store.accounts.entries()) {
      const state = store.states.get(name);
      if (!state) continue;
      if (!state.id && acc.id) state.id = acc.id;
      if (acc.loginInfo?.mobilephone) {
        state.user = acc.loginInfo.mobilephone;
        acc.user = acc.loginInfo.mobilephone;
      }
      if (!acc.taskConfig) acc.taskConfig = { enabled: true, aiChat: true };
      state.autoStart = acc.autoStart;
      state.taskConfig = acc.taskConfig;
      state.redeemConfig = acc.redeemConfig;

      // 跨天保护：缓存日期与东八区当日不一致时直接归零
      const pts = store.todayPointsCache.get(name);
      const todayStr = getCstDateString();
      state.todayPoints = pts && pts.date === todayStr ? (pts.todayPoints ?? 0) : 0;
    }

    return Array.from(store.states.values()).map((state) => {
      const sanitized = this.sanitizeAccount(state);
      if (sanitized.desktops && sanitized.name) {
        sanitized.desktops = sanitized.desktops.map((d) => {
          const dKey = String(d.desktopCode || d.desktopId || '');
          const info = this.watchdogService.getWatchdogInfo(sanitized.name, dKey);
          const webActive =
            this.webActiveTracker.isWebActive(String(d.desktopCode || '')) ||
            this.webActiveTracker.isWebActive(String(d.desktopId || ''));
          const next: typeof d = { ...d };

          if (info) {
            next.watchdog = {
              active: true,
              currentIntervalSec: info.currentIntervalSec,
              nextProbeSec: info.nextProbeSec,
              failRounds: info.failRounds,
            };
          }
          if (webActive || info || d.status === 'paused') {
            next.yieldStatus = {
              active: true,
              yielding: true,
              reason: webActive ? '前台浏览器直连操作中，后台已主动让位' : '检测到外部客户端在线，后台已主动让位',
              remainingSeconds: info?.nextProbeSec ?? 0,
            };
          }
          return next;
        });
      }
      return sanitized;
    });
  }

  /** 0 点跨天重置今日积分缓存 (纯本地归零，不请求官方接口) */
  public resetTodayPointsAtMidnight(): void {
    this.store.resetTodayPoints(getCstDateString());
    this.logger.addLog('info', `到达 00:00 跨天时间节点，今日已获积分已平滑清零重置`);
    this.notifyStatusChange();
  }

  // ---- 账号生命周期 ----

  public async startAccount(accountName: string): Promise<void> {
    const acc = this.store.accounts.get(accountName);
    const state = this.store.states.get(accountName);
    if (!acc || !state) throw new Error(`未找到账号: ${accountName}`);

    const client = this.getClient(accountName);
    if (!client.loginInfo) {
      state.status = 'login_needed';
      throw new Error(`账号未登录，请在控制台输入验证码登录`);
    }

    this.watchdogService.stopWatchdogsForAccount(accountName);

    // 先同步状态并广播，避免前端等待外部网络 I/O
    acc.autoStart = true;
    this.saveToDisk();
    state.status = 'online';
    this.notifyStatusChange();

    this.reloadDesktops(accountName).catch((err) => {
      this.logger.addLog('warn', `[${accountName}] 同步云电脑列表提示: ${err.message}`);
    });
    this.getPointsAndTasks(accountName)
      .then(() => this.notifyStatusChange())
      .catch(() => {});
  }

  public stopAccount(accountName: string): void {
    const acc = this.store.accounts.get(accountName);
    if (acc) acc.autoStart = false;
    // 清空在途同步标记，防止停机后飞行中的 reloadDesktops 重建 Worker
    this.reloadDesktopsPromises.delete(accountName);
    this.keepaliveService.stopWorkers(accountName);
    this.watchdogService.stopWatchdogsForAccount(accountName);
    this.powerTracker.clearForAccount(accountName);
    this.saveToDisk();

    const state = this.store.states.get(accountName);
    if (state) {
      state.status = 'idle';
      for (const d of state.desktops) d.status = 'stopped';
    }
    this.logger.addLog('warn', `[${accountName}] 保活任务已手动停止（彻底静默，无探针无长连）`);
    this.notifyStatusChange();
  }

  public async stopAll(): Promise<void> {
    this.taskScheduler.stop();
    this.keepaliveService.stopAll();
    this.watchdogService.stopAll();
    this.powerTracker.clearAll();
    this.webActiveTracker.clearAll();
    this.saveToDisk(true);
  }

  public async operateDesktop(accountName: string, desktopCode: string, operation: PowerOperation): Promise<string> {
    const state = this.store.states.get(accountName);
    const client = this.getClient(accountName);
    const codeStr = String(desktopCode).trim();
    const desktop = state?.desktops.find((item) => String(item.desktopCode) === codeStr);
    if (!state || !desktop || !client.loginInfo) throw new Error('未找到可操作的云电脑或账号未登录');

    const canonicalDesktopCode = desktop.desktopCode;
    const requestApiDesktopId = desktop.desktopId;

    const isShutdown = operation === 'shutdown' || operation === 'off' || operation === 'stop';
    const isReset = operation === 'reset' || operation === 'reboot' || operation === 'restart';

    if (isShutdown || isReset) {
      if (isShutdown) this.setManualShutdown(canonicalDesktopCode, true);
      this.keepaliveService.stopWorkerForDesktop(accountName, canonicalDesktopCode);
      desktop.status = 'stopped';
      desktop.lastHeartbeat = undefined;
      desktop.useStatusText = isShutdown ? '已关机' : '重启中';
      this.notifyStatusChange();
    } else {
      this.setManualShutdown(canonicalDesktopCode, false);
      desktop.status = 'connecting';
      desktop.useStatusText = operation === 'awake' ? '唤醒中' : '启动中';
      this.notifyStatusChange();
    }

    try {
      const targetObjType = typeof desktop.objType === 'number' ? desktop.objType : 0;
      const dName = desktop.desktopName || desktop.computerName || desktop.name || canonicalDesktopCode;
      const dPrefix = dName ? `${accountName} - ${dName}` : accountName;

      let message = '';
      if (operation === 'on' || operation === 'awake') {
        // 智能探测：休眠优先发 18 唤醒、关机优先发 1 开机；失败时双向回退互补
        const isSleep = normalizeUseStatusText(desktop.useStatusText) === 'suspended' || operation === 'awake';
        const primaryOp: 'on' | 'awake' = isSleep ? 'awake' : 'on';
        const fallbackOp: 'on' | 'awake' = isSleep ? 'on' : 'awake';

        try {
          message = await client.operateDesktop(requestApiDesktopId, primaryOp, targetObjType);
        } catch (firstErr) {
          const firstErrMsg = errorText(firstErr);
          if (firstErrMsg.includes('已运行') || firstErrMsg.includes('已经处于') || firstErrMsg.includes('已在运行')) {
            message = '云电脑已处于运行可用状态';
          } else {
            try {
              message = await client.operateDesktop(requestApiDesktopId, fallbackOp, targetObjType);
            } catch (secondErr) {
              // 两路信令均失败时，借 connectDesktop 触发官方云端 goingRetry 拉起
              try {
                await client.connectDesktop(desktop.desktopCode || desktop.desktopId, targetObjType);
                message = '云电脑拉起请求已触发，正在建立连接...';
              } catch {
                throw secondErr;
              }
            }
          }
        }
      } else {
        message = await client.operateDesktop(requestApiDesktopId, operation, targetObjType);
      }

      this.logger.addLog('info', `[${dPrefix}] ${message}`);
      const trackTarget: 'on' | 'shutdown' | 'reset' = isShutdown ? 'shutdown' : isReset ? 'reset' : 'on';
      this.powerTracker.trackDesktopStatusAfterPower(accountName, canonicalDesktopCode, trackTarget);
      return message;
    } catch (error) {
      desktop.status = 'stopped';
      desktop.useStatusText = '操作失败';
      this.notifyStatusChange();
      throw error;
    }
  }

  public async getDesktopDirectUrlByDesktopCode(
    desktopCode: string,
    accountHint?: string,
  ): Promise<{ url: string; desktopCode: string; accountName: string }> {
    const { accountName, desktop } = await this.resolveDesktop(desktopCode, accountHint);
    const client = this.getClient(accountName);
    if (!client || !client.loginInfo) {
      throw new Error(`云电脑所属账号 [${accountName}] 未登录或凭据失效`);
    }
    const code = desktop.desktopCode || '';
    // 纯同源 Cookie 鉴权，严禁在 URL 携带 token
    return { url: `/desktop/${encodeURIComponent(code)}`, desktopCode: code, accountName };
  }

  public updateAccountName(oldName: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    if (this.store.accounts.has(trimmed)) throw new Error(`已存在名为 [${trimmed}] 的账号`);

    const acc = this.store.getAccount(oldName);
    if (!acc) throw new Error('未找到该账号');
    const realOldName = acc.name;
    if (realOldName === trimmed) return;

    this.keepaliveService.stopWorkers(realOldName);
    this.watchdogService.stopWatchdogsForAccount(realOldName);

    const { acc: renamed, client } = this.store.rename(realOldName, trimmed);
    this.powerTracker.renameAccount(realOldName, trimmed);

    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${realOldName}] 备注名称已修改为 [${trimmed}]`);

    if (renamed.loginInfo && client) {
      this.reloadDesktops(trimmed).catch(() => {});
      this.getPointsAndTasks(trimmed)
        .then(() => this.notifyStatusChange())
        .catch(() => {});
    }
  }

  // ---- 云电脑同步 ----

  public async reloadDesktops(accountName: string): Promise<void> {
    const existing = this.reloadDesktopsPromises.get(accountName);
    if (existing) return existing;

    const task = (async () => {
      try {
        await this._doReloadDesktops(accountName);
      } finally {
        this.reloadDesktopsPromises.delete(accountName);
      }
    })();

    this.reloadDesktopsPromises.set(accountName, task);
    return task;
  }

  private async _doReloadDesktops(accountName: string): Promise<void> {
    const acc = this.store.accounts.get(accountName);
    const state = this.store.states.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !state || !client.loginInfo) return;

    let list: Desktop[] = [];
    try {
      list = await client.getDesktopList();
    } catch (err) {
      const errMsg = errorText(err);
      state.status = 'error';
      state.lastError = errMsg;
      this.logger.addLog('error', `[${accountName}] 拉取云电脑失败: ${errMsg}`);

      const lowerMsg = errMsg.toLowerCase();
      const isAuthFailure =
        lowerMsg.includes('登录') ||
        lowerMsg.includes('token') ||
        lowerMsg.includes('401') ||
        lowerMsg.includes('过期') ||
        lowerMsg.includes('失效') ||
        lowerMsg.includes('重新登录');
      if (isAuthFailure) {
        state.status = 'login_needed';
        if (this.webhookUrl && !this.expiredNotifiedAccounts.has(accountName)) {
          this.expiredNotifiedAccounts.add(accountName);
          NotifyService.sendNotification(
            this.webhookUrl,
            `天翼云电脑 - [${accountName}] 登录态失效告警`,
            `账号: ${accountName}\n错误: ${errMsg}\n状态: 登录凭证已失效或被踢出，已暂停自动任务。\n请尽快登录 Web 控制台重新扫码登录！`,
          ).catch(() => {});
        }
      }
      return;
    }

    this.expiredNotifiedAccounts.delete(accountName);

    if (!list || list.length === 0) {
      this.logger.addLog('warn', `[${accountName}] 该账号下未找到可用云电脑`);
      state.desktops = [];
      return;
    }

    // 外部开机自愈：实例已恢复运行态时解除本地手动关机锁定
    for (const d of list) {
      const isRunning = normalizeUseStatusText(d.useStatusText) === 'running';
      if (isRunning && (this.isManualShutdown(d.desktopCode) || this.isManualShutdown(d.desktopId))) {
        this.setManualShutdown(d.desktopCode, false);
        this.setManualShutdown(d.desktopId, false);
        this.logger.addLog('info', `[${accountName} - ${d.desktopName || d.desktopCode}] 检测到云电脑在外部已开机启动，自动解除本地手动关机标记`);
      }
    }

    const oldDesktopsMap = new Map(state.desktops.map((d) => [d.desktopId, d]));
    state.desktops = list.map((d) => mergeDesktopState(d, oldDesktopsMap.get(d.desktopId)));
    acc.desktops = state.desktops.map(toPersistedDesktop);
    this.saveToDisk();

    if (acc.autoStart === false) {
      this.keepaliveService.stopWorkers(accountName);
      for (const d of state.desktops) d.status = 'stopped';
      return;
    }

    await this.keepaliveService.syncWorkersForAccount(
      accountName,
      client,
      list,
      state.desktops,
      (dId) => this.isManualShutdown(dId),
      (dId) => this.isWebUserActive(dId),
    );
  }

  public async addOrUpdateAccount(config: AccountConfig): Promise<void> {
    const { name } = this.store.upsert(config);
    this.saveToDisk();
    this.notifyStatusChange();

    if (config.loginInfo) {
      void (async () => {
        try {
          await this.getPointsAndTasks(name);
        } catch (e) {
          this.logger.addLog('warn', `[${name}] 后台同步提示: ${errorText(e)}`);
        } finally {
          this.notifyStatusChange();
        }
      })();
    }
  }

  public removeAccount(name: string): void {
    this.powerTracker.clearForAccount(name);
    this.keepaliveService.stopWorkers(name);
    this.watchdogService.stopWatchdogsForAccount(name);
    this.expiredNotifiedAccounts.delete(name);
    this.reloadDesktopsPromises.delete(name);
    this.store.remove(name);
    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${name}] 账号已移除`);
  }

  // ---- 任务/积分/兑换代理 ----

  public async manualAiChat(accountName: string): Promise<string> {
    return this.tasksService.runAiChat(accountName);
  }

  public async getPointDetailList(
    accountName: string,
    options: { pageNum?: number; pageSize?: number; msgType?: number } = {},
  ) {
    return this.tasksService.getPointDetailList(accountName, options);
  }

  public async manualRedeem(
    accountName: string,
    prodId?: number,
    costPoints?: number,
    prodType?: string,
    desktopId?: string,
    options: { costPointType?: number; count?: number; mobilephone?: string } = {},
  ): Promise<string> {
    return this.tasksService.redeem(accountName, prodId, costPoints, prodType, desktopId, options);
  }

  public async getAvailableRewards(accountName?: string, forceRefresh = false): Promise<RewardItem[]> {
    return this.tasksService.getAvailableRewards(accountName, forceRefresh);
  }

  public async getPointsAndTasks(accountName: string): Promise<PointsSummary> {
    return this.tasksService.getPointsAndTasks(accountName);
  }

  // ---- 配置持久化 ----

  public exportConfigSafe() {
    return this.store.exportConfigSafe();
  }

  public importConfigSafe(data: unknown): { importedAccounts: number } {
    const res = this.store.importConfigSafe(data);
    if (res.webhookUrl !== undefined) this.webhookUrl = res.webhookUrl;
    this.saveToDisk();
    return { importedAccounts: res.importedAccounts };
  }

  public saveToDisk(immediate = false): void {
    this.store.saveToDisk(immediate);
  }

  public loadFromDisk(): void {
    const { autoStartAccountNames } = this.store.loadFromDisk();
    this.logger.addLog('info', `已加载本地配置文件 (${this.store.accounts.size} 个账号)`);

    // 每账号错峰 800ms 启动，避免瞬时并发冲击官方接口
    let delayMs = 0;
    for (const name of autoStartAccountNames) {
      const staggerDelay = delayMs;
      delayMs += 800;
      setTimeout(() => {
        this.reloadDesktops(name).catch((err) => {
          this.logger.addLog('warn', `[${name}] 自启动保活提示: ${err.message}`);
        });
        this.getPointsAndTasks(name)
          .then(() => this.notifyStatusChange())
          .catch(() => {});
      }, staggerDelay);
    }
  }

}
