import crypto from 'node:crypto';
import { Config, getRandomScheduleTime, DEFAULT_REDEEM_CONFIG, type AccountConfig, type TaskConfig, type RedeemConfig } from '../config.js';
import { CtYunClient, type Desktop, type DesktopInfo, type LoginInfo } from './client.js';
import { KeepaliveService, type ManagedDesktopState } from '../modules/keepalive/index.js';
import { WatchdogService } from '../modules/watchdog/index.js';
import { Logger, type LogItem } from './logger.js';
import { TaskScheduler, PointsTask, AiChatTask, type PointsSummary } from '../modules/tasks/index.js';
import { RewardRedeemService, DEFAULT_LOCAL_REWARDS, sortRewards, type RewardItem } from '../modules/reward/index.js';
import { safeWriteFileSync, sendWebhookNotification, getCstDateString, getCstDateTimeString } from './utils.js';
import type { DesktopInstanceSummary } from '../types/index.js';

import { AccountRepository, AccountSanitizer } from '../modules/account/index.js';
import { WebActiveTracker, DesktopPowerTracker } from '../modules/desktop/index.js';

export { type ManagedAccount } from '../types/index.js';
import type { ManagedAccount } from '../types/index.js';

/**
 * 账号与系统顶层业务管理者
 * 协调：账号认证存储、保活服务 (KeepaliveService)、定时调度器 (TaskScheduler)
 */
export class ProfileManager {
  private accounts: Map<string, AccountConfig> = new Map();
  private clients: Map<string, CtYunClient> = new Map();
  private accountStates: Map<string, ManagedAccount> = new Map();
  private logger: Logger = new Logger();
  private keepaliveService: KeepaliveService;
  private watchdogService: WatchdogService;
  private taskScheduler: TaskScheduler;
  private statusListeners: Set<() => void> = new Set();

  public keepAliveSeconds = 60;
  public adminPassword = '';
  public webhookUrl = '';
  public rewardsCache: RewardItem[] = [...DEFAULT_LOCAL_REWARDS];
  private todayPointsCache: Map<string, { todayPoints: number; date: string; summary?: PointsSummary; updatedAt: number }> = new Map();
  private expiredNotifiedAccounts: Set<string> = new Set();
  private manualShutdownDesktops: Set<string> = new Set();
  // 账号云电脑同步互斥锁 (按账号 Promise 排重，防止并发多重触发)
  private reloadDesktopsPromises: Map<string, Promise<void>> = new Map();

  private repository = new AccountRepository();
  private webActiveTracker = new WebActiveTracker();
  private powerTracker: DesktopPowerTracker;

  constructor() {
    this.keepaliveService = new KeepaliveService(this.logger, () => this.notifyStatusChange());
    this.watchdogService = new WatchdogService({
      profileManager: this,
      logger: this.logger,
    });
    this.taskScheduler = new TaskScheduler(this, this.logger);
    this.powerTracker = new DesktopPowerTracker(this.logger, {
      getClient: (name) => this.getClient(name),
      hasAccount: (name) => this.accounts.has(name),
      getDesktopState: (name, dId) => {
        const state = this.accountStates.get(name);
        return state?.desktops.find((d) => String(d.desktopCode) === String(dId) || String(d.desktopId) === String(dId));
      },
      notifyStatusChange: () => this.notifyStatusChange(),
      onPowerOnSuccess: (name) => {
        setTimeout(() => {
          this.reloadDesktops(name).catch(() => {});
        }, 2000);
      },
      onPowerTimeout: (name) => {
        this.reloadDesktops(name).catch(() => {});
      },
    });
    this.loadFromDisk();
    this.taskScheduler.start();

    // 监听保活服务派发的桌面进入 paused 事件，启动避让自愈看门狗
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

  public getAccountNameByDesktopCode(desktopCode: string): string | undefined {
    const codeStr = String(desktopCode).trim();
    for (const [name, state] of this.accountStates.entries()) {
      const d = state.desktops.find((item) => String(item.desktopCode) === codeStr || String(item.desktopId) === codeStr);
      if (d) return name;
    }
    for (const [name, acc] of this.accounts.entries()) {
      const d = (acc.desktops || []).find((item) => String(item.desktopCode) === codeStr || String(item.desktopId) === codeStr);
      if (d) return name;
    }
    return undefined;
  }

  /**
   * 通过全局唯一 desktopCode 或 desktopId 反查账号与桌面实例信息
   */
  public findDesktopByCode(desktopCode: string): { accountName: string; desktop: ManagedDesktopState } | undefined {
    if (!desktopCode) return undefined;
    const codeStr = String(desktopCode).trim();
    for (const [name, state] of this.accountStates.entries()) {
      const d = state.desktops.find((item) => String(item.desktopCode) === codeStr || String(item.desktopId) === codeStr);
      if (d) {
        return { accountName: name, desktop: d };
      }
    }
    // 兜底查 accounts 原生配置
    for (const [name, acc] of this.accounts.entries()) {
      const d = (acc.desktops || []).find((item) => String(item.desktopCode) === codeStr || String(item.desktopId) === codeStr);
      if (d) {
        return { accountName: name, desktop: d as ManagedDesktopState };
      }
    }
    return undefined;
  }

  public touchWebUserActive(accountName: string, desktopCode: string, _durationSec: number = 60): void {
    const matched = this.findDesktopByCode(desktopCode);
    const matchedAccount = accountName || matched?.accountName || this.getAccountNameByDesktopCode(desktopCode);
    if (!matchedAccount) return;
    
    const canonicalKey = matched?.desktop?.desktopCode || desktopCode;
    this.webActiveTracker.touchWebActive(canonicalKey, () => {
      this.keepaliveService.pauseWorkerForDesktop(matchedAccount, canonicalKey);
      const matchedId = matched?.desktop?.desktopId || canonicalKey;
      this.watchdogService.stopWatchdog(matchedAccount, String(matchedId));
      if (matched?.desktop?.desktopCode) {
        this.watchdogService.stopWatchdog(matchedAccount, String(matched.desktop.desktopCode));
      }
    });
  }

  public releaseWebUserActive(accountName: string, desktopCode: string, delaySec: number = 20): void {
    const matched = this.findDesktopByCode(desktopCode);
    const matchedAccount = accountName || matched?.accountName || this.getAccountNameByDesktopCode(desktopCode);
    if (!matchedAccount) return;
    
    const canonicalKey = matched?.desktop?.desktopCode || desktopCode;
    this.webActiveTracker.releaseWebActive(canonicalKey, delaySec, async () => {
      const acc = this.accounts.get(matchedAccount);
      if (acc && acc.autoStart !== false) {
        await this.keepaliveService.resumeWorkerForDesktop(matchedAccount, canonicalKey);
      }
    });
  }

  public isManualShutdown(desktopCode: string): boolean {
    return this.manualShutdownDesktops.has(desktopCode);
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

    // 1. 调用天翼云官方 API 修改云电脑名称
    await client.modifyDesktopNickName(dId, trimmed);

    // 2. 更新内存中云电脑名称
    desktop.desktopName = trimmed;
    const state = this.accountStates.get(accountName);
    if (state && state.desktops) {
      const target = state.desktops.find((d) => String(d.desktopCode) === String(desktopCode) || String(d.desktopId) === dId);
      if (target) {
        target.desktopName = trimmed;
      }
    }

    // 3. 更新配置中缓存的云电脑列表并持久化
    const acc = this.accounts.get(accountName);
    if (acc && acc.desktops) {
      const targetConfig = acc.desktops.find((d) => String(d.desktopCode) === String(desktopCode) || String(d.desktopId) === dId);
      if (targetConfig) {
        targetConfig.desktopName = trimmed;
      }
    }

    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${accountName} - ${trimmed}] 云电脑名称已成功修改为 [${trimmed}] (原名: [${oldName}])`);
    return true;
  }

  public setManualShutdown(desktopCode: string, manual: boolean): void {
    if (manual) {
      this.manualShutdownDesktops.add(desktopCode);
    } else {
      this.manualShutdownDesktops.delete(desktopCode);
    }
  }

  public getLogger(): Logger {
    return this.logger;
  }

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

  public getAllAccounts(): Map<string, AccountConfig> {
    return this.accounts;
  }

  public getAccount(keyOrId: string): AccountConfig | undefined {
    if (!keyOrId) return undefined;
    // 1. 优先按不可变 id (UUID) 匹配
    for (const a of this.accounts.values()) {
      if (a.id === keyOrId) return a;
    }
    // 2. 兼容按 Map Key 查找
    let acc = this.accounts.get(keyOrId);
    if (!acc) {
      // 3. 兼容按 user (手机号) 或 name 模糊回退匹配
      for (const a of this.accounts.values()) {
        if (a.user === keyOrId || a.name === keyOrId) {
          acc = a;
          break;
        }
      }
    }
    return acc;
  }

  public sanitizeLoginInfo(info?: LoginInfo): LoginInfo | undefined {
    return AccountSanitizer.sanitizeLoginInfo(info);
  }

  public sanitizeAccount(accountOrState: ManagedAccount | AccountConfig): ManagedAccount;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined {
    return AccountSanitizer.sanitizeAccount(accountOrState);
  }

  public getAccountState(keyOrId: string): ManagedAccount | undefined {
    if (!keyOrId) return undefined;
    // 1. 优先按不可变 id (UUID) 匹配
    for (const s of this.accountStates.values()) {
      if (s.id === keyOrId) return this.sanitizeAccount(s);
    }
    // 2. 兼容按 Map Key 查找
    let state = this.accountStates.get(keyOrId);
    if (!state) {
      // 3. 兼容按 user (手机号) 或 name 模糊回退匹配
      for (const s of this.accountStates.values()) {
        if (s.user === keyOrId || s.name === keyOrId) {
          state = s;
          break;
        }
      }
    }
    return state ? this.sanitizeAccount(state) : undefined;
  }

  public getClient(keyOrId: string): CtYunClient {
    const acc = this.getAccount(keyOrId);
    const key = acc?.name || keyOrId;
    let client = this.clients.get(key);
    if (!client) {
      const devCode = acc?.deviceCode || Config.resolveDeviceCode(key);
      client = new CtYunClient(devCode);
      if (acc?.loginInfo) {
        client.loginInfo = acc.loginInfo;
      }
      this.clients.set(key, client);
    }
    return client;
  }

  public getAccountsSummary(): ManagedAccount[] {
    for (const [name, acc] of this.accounts.entries()) {
      const state = this.accountStates.get(name);
      if (state) {
        if (!state.id && acc.id) {
          state.id = acc.id;
        }
        if (acc.loginInfo?.mobilephone) {
          state.user = acc.loginInfo.mobilephone;
          acc.user = acc.loginInfo.mobilephone;
        }
        if (!acc.taskConfig) {
          acc.taskConfig = {
            enabled: true,
            aiChat: true,
          };
        }
        state.autoStart = acc.autoStart;
        state.taskConfig = acc.taskConfig;
        state.redeemConfig = acc.redeemConfig;
        const pts = this.todayPointsCache.get(name);
        const todayStr = getCstDateString();
        // 严格自然日校验：仅在缓存日期与东八区当天一致时有效，跨天直接归零
        state.todayPoints = (pts && pts.date === todayStr) ? (pts.todayPoints ?? 0) : 0;
      }
    }
    return Array.from(this.accountStates.values()).map((state) => {
      const sanitized = this.sanitizeAccount(state);
      if (sanitized.desktops && sanitized.name) {
        sanitized.desktops = sanitized.desktops.map((d) => {
          const dKey = String(d.desktopCode || d.desktopId || '');
          const info = this.watchdogService.getWatchdogInfo(sanitized.name, dKey);
          if (info) {
            return {
              ...d,
              watchdog: {
                active: true,
                currentIntervalSec: info.currentIntervalSec,
                nextProbeSec: info.nextProbeSec,
                failRounds: info.failRounds,
              },
            };
          }
          return d;
        });
      }
      return sanitized;
    });
  }

  /**
   * 0 点跨天重置所有账号的今日积分缓存 (纯本地时钟归零，不请求官方接口)
   */
  public resetTodayPointsAtMidnight(): void {
    const todayStr = getCstDateString();
    for (const [name, state] of this.accountStates.entries()) {
      state.todayPoints = 0;
      const cached = this.todayPointsCache.get(name);
      if (cached) {
        cached.todayPoints = 0;
        cached.date = todayStr;
      }
    }
    this.logger.addLog('info', `到达 00:00 跨天时间节点，今日已获积分已平滑清零重置`);
    this.notifyStatusChange();
  }

  /**
   * 获取指定账号的今日任务积分缓存 (若存在)
   */
  public getCachedTodayPoints(accountName: string) {
    return this.todayPointsCache.get(accountName);
  }

  /**
   * 获取全局一等公民实例列表 (合并所属 Profile 信息与实时保活状态)
   */
  public getAllInstancesSummary(): DesktopInstanceSummary[] {
    const list: DesktopInstanceSummary[] = [];
    for (const [name, acc] of this.accounts.entries()) {
      const state = this.accountStates.get(name);
      const desktops = state?.desktops?.length ? state.desktops : (acc.desktops || []);
      for (const d of desktops) {
        const desktopCode = d.desktopCode || d.desktopId;
        list.push({
          id: desktopCode,
          desktopCode,
          desktopName: d.desktopName || '',
          flavorName: d.flavorName || d.desktopName,
          imageName: d.imageName,
          useStatusText: d.useStatusText || '空闲',
          status: d.status || 'idle',
          lastHeartbeat: typeof d.lastHeartbeat === 'string' ? d.lastHeartbeat : undefined,
          profileId: acc.id || state?.id,
          profileName: acc.name,
          profileUser: acc.user,
        });
      }
    }
    return list;
  }

  public async startAccount(accountName: string): Promise<void> {
    const acc = this.accounts.get(accountName);
    const state = this.accountStates.get(accountName);
    if (!acc || !state) throw new Error(`未找到账号: ${accountName}`);

    const client = this.getClient(accountName);
    if (!client.loginInfo) {
      state.status = 'login_needed';
      throw new Error(`账号未登录，请在控制台输入验证码登录`);
    }

    // 开启前清理该账号名下可能存在的休眠自愈看门狗定时器
    this.watchdogService.stopWatchdogsForAccount(accountName);

    // 立即秒级更新状态并广播通知前端，避免用户等待外部网络 I/O
    acc.autoStart = true;
    this.saveToDisk();
    state.status = 'online';
    this.notifyStatusChange();

    // 异步在后台并行拉取最新云电脑与建立保活 worker，零阻塞前端
    this.reloadDesktops(accountName).catch((err) => {
      this.logger.addLog('warn', `[${accountName}] 同步云电脑列表提示: ${err.message}`);
    });

    // 异步拉取一次最新积分数据更新当日已获积分，避免重启后显示为 0
    this.getPointsAndTasks(accountName)
      .then(() => this.notifyStatusChange())
      .catch(() => {});
  }

  public stopAccount(accountName: string): void {
    const acc = this.accounts.get(accountName);
    if (acc) {
      acc.autoStart = false;
      this.saveToDisk();
    }
    // 停止长连接
    this.keepaliveService.stopWorkers(accountName);
    // 彻底停止：清除该账号名下所有看门狗定时器，彻底静默，绝不探测 HTTP 也绝不发起 WebSocket
    this.watchdogService.stopWatchdogsForAccount(accountName);

    const state = this.accountStates.get(accountName);
    if (state) {
      state.status = 'idle';
      for (const d of state.desktops) {
        d.status = 'stopped';
      }
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

  public async operateDesktop(
    accountName: string,
    desktopCode: string,
    operation: 'on' | 'awake' | 'shutdown' | 'reset' | 'off' | 'stop' | 'reboot' | 'restart' | 'force_off' | 'force_reboot',
  ): Promise<string> {
    const state = this.accountStates.get(accountName);
    const client = this.getClient(accountName);
    const codeStr = String(desktopCode).trim();
    const desktop = state?.desktops.find((item) => String(item.desktopCode) === codeStr);
    if (!state || !desktop || !client.loginInfo) throw new Error('未找到可操作的云电脑或账号未登录');

    const canonicalDesktopCode = desktop.desktopCode;
    const requestApiDesktopId = desktop.desktopId;

    const isShutdown = operation === 'shutdown' || operation === 'off' || operation === 'stop' || operation === 'force_off';
    const isReset = operation === 'reset' || operation === 'reboot' || operation === 'restart' || operation === 'force_reboot';

    if (isShutdown || isReset) {
      if (isShutdown) {
        this.setManualShutdown(canonicalDesktopCode, true);
      }
      this.keepaliveService.stopWorkerForDesktop(accountName, canonicalDesktopCode);
      desktop.status = 'stopped';
      desktop.lastHeartbeat = undefined;
      desktop.useStatusText = isShutdown ? (operation === 'force_off' ? '正在强制关机' : '已关机') : (operation === 'force_reboot' ? '正在强制重启' : '重启中');
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
      const isPowerOnOrAwake = operation === 'on' || operation === 'awake';
      
      if (isPowerOnOrAwake) {
        // 智能电源探测：若云电脑状态提示休眠或指定 awake，优先发 18 唤醒；若提示关机则发 1 开机；失败时双向回退互补
        const isSleep = (desktop.useStatusText || '').includes('休眠') || (desktop.useStatusText || '').includes('睡眠') || operation === 'awake';
        const primaryOp: 'on' | 'awake' = isSleep ? 'awake' : 'on';
        const fallbackOp: 'on' | 'awake' = isSleep ? 'on' : 'awake';

        try {
          message = await client.operateDesktop(requestApiDesktopId, primaryOp, targetObjType);
        } catch (firstErr) {
          const firstErrMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          if (firstErrMsg.includes('已运行') || firstErrMsg.includes('已经处于') || firstErrMsg.includes('已在运行')) {
            message = '云电脑已处于运行可用状态';
          } else {
            try {
              message = await client.operateDesktop(requestApiDesktopId, fallbackOp, targetObjType);
            } catch (secondErr) {
              // 若两路信令均失败，尝试通过 connectDesktop 接口触发官方云端的 goingRetry 机制拉起桌面
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
      // 后台轮询跟踪云电脑电源状态，直至真正开机或关机完成
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

  /**
   * 精准反查云电脑实例及归属账号
   * 优先提示排查 -> 内存状态反查 -> 全量刷新重载兜底
   */
  public async resolveDesktop(
    desktopCode: string,
    accountHint?: string,
  ): Promise<{ accountName: string; desktop: ManagedDesktopState }> {
    if (!desktopCode) {
      throw new Error('缺少全局唯一 desktopCode');
    }

    const codeStr = String(desktopCode).trim();
    let matchedAccountName: string | undefined;
    let targetDesktop: ManagedDesktopState | undefined;

    // 1. 优先根据账号提示快速定位
    if (accountHint) {
      const state = this.accountStates.get(accountHint);
      const d = state?.desktops.find((item) => String(item.desktopCode) === codeStr || String(item.desktopId) === codeStr);
      if (d) {
        matchedAccountName = state!.name;
        targetDesktop = d;
      }
    }

    // 2. 全局遍历所有已托管账号的桌面状态
    if (!targetDesktop) {
      for (const [name, state] of this.accountStates.entries()) {
        const d = state.desktops.find((item) => String(item.desktopCode) === codeStr || String(item.desktopId) === codeStr);
        if (d) {
          matchedAccountName = name;
          targetDesktop = d;
          break;
        }
      }
    }

    // 3. 内存未命中时，尝试全量刷新各账号桌面后再反查
    if (!targetDesktop) {
      for (const name of this.accounts.keys()) {
        try {
          await this.reloadDesktops(name);
          const state = this.accountStates.get(name);
          const d = state?.desktops.find((item) => String(item.desktopCode) === codeStr || String(item.desktopId) === codeStr);
          if (d) {
            matchedAccountName = name;
            targetDesktop = d;
            break;
          }
        } catch {}
      }
    }

    if (!matchedAccountName || !targetDesktop) {
      throw new Error(`未找到设备编码为 [${desktopCode}] 的云电脑实例`);
    }

    return { accountName: matchedAccountName, desktop: targetDesktop };
  }

  /**
   * 通过全局唯一 desktopCode 反查账号与桌面，生成标准同源远程桌面直连链接
   * （纯同源 Cookie/Pinia 鉴权，严禁在 URL 中拼接 token 泄露凭据）
   */
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
    const directUrl = `/desktop/${encodeURIComponent(code)}`;
    this.logger.addLog('info', `[${accountName}] 生成同源远程桌面直连视窗链接 (${code})`);
    return { url: directUrl, desktopCode: code, accountName };
  }

  public updateAccountName(oldName: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    if (this.accounts.has(trimmed)) {
      throw new Error(`已存在名为 [${trimmed}] 的账号`);
    }

    const acc = this.getAccount(oldName);
    if (!acc) throw new Error('未找到该账号');
    const realOldName = acc.name;
    if (realOldName === trimmed) return;

    const state = this.accountStates.get(realOldName);
    const client = this.clients.get(realOldName);

    this.keepaliveService.stopWorkers(realOldName);
    this.watchdogService.stopWatchdogsForAccount(realOldName);
    this.accounts.delete(realOldName);
    this.accountStates.delete(realOldName);
    if (client) this.clients.delete(realOldName);

    acc.name = trimmed;
    this.accounts.set(trimmed, acc);

    if (state) {
      state.name = trimmed;
      this.accountStates.set(trimmed, state);
    }
    if (client) {
      this.clients.set(trimmed, client);
    }

    const pts = this.todayPointsCache.get(realOldName);
    if (pts) {
      this.todayPointsCache.delete(realOldName);
      this.todayPointsCache.set(trimmed, pts);
    }

    this.powerTracker.renameAccount(realOldName, trimmed);

    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${realOldName}] 备注名称已修改为 [${trimmed}]`);

    if (acc.loginInfo) {
      this.reloadDesktops(trimmed).catch(() => {});
      this.getPointsAndTasks(trimmed)
        .then(() => this.notifyStatusChange())
        .catch(() => {});
    }
  }

  public async reloadDesktops(accountName: string): Promise<void> {
    const existing = this.reloadDesktopsPromises.get(accountName);
    if (existing) {
      return existing;
    }

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
    const acc = this.accounts.get(accountName);
    const state = this.accountStates.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !state || !client.loginInfo) return;

    let list: Desktop[] = [];
    try {
      list = await client.getDesktopList();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      state.status = 'error';
      state.lastError = errMsg;
      this.logger.addLog('error', `[${accountName}] 拉取云电脑失败: ${errMsg}`);

      // 检测是否为 Token 过期或未登录
      const lowerMsg = errMsg.toLowerCase();
      if (
        lowerMsg.includes('登录') ||
        lowerMsg.includes('token') ||
        lowerMsg.includes('401') ||
        lowerMsg.includes('过期') ||
        lowerMsg.includes('失效') ||
        lowerMsg.includes('重新登录')
      ) {
        state.status = 'login_needed';
        if (this.webhookUrl && !this.expiredNotifiedAccounts.has(accountName)) {
          this.expiredNotifiedAccounts.add(accountName);
          const title = `天翼云电脑 - [${accountName}] 登录态失效告警`;
          const content = `账号: ${accountName}\n错误: ${errMsg}\n状态: 登录凭证已失效或被踢出，已暂停自动任务。\n请尽快登录 Web 控制台重新扫码登录！`;
          sendWebhookNotification(this.webhookUrl, title, content).catch(() => {});
        }
      }
      return;
    }

    // 成功拉取列表说明 Token 正常有效，重置告警去重状态
    this.expiredNotifiedAccounts.delete(accountName);

    if (!list || list.length === 0) {
      this.logger.addLog('warn', `[${accountName}] 该账号下未找到可用云电脑`);
      state.desktops = [];
      return;
    }

    // 维持既有桌面心跳与状态，防止重复覆盖
    const oldDesktopsMap = new Map(state.desktops.map(d => [d.desktopId, d]));
    state.desktops = list.map((d) => {
      // 外部开机状态自愈探针：若在外部 App/客户端或控制台开机 (useStatus === 25 或 useStatusText 为运行中)
      // 且本地仍处于手动关机锁定标记中，自动解除手动关机标记，恢复守护
      const isRunning = d.useStatus === 25 || (d.useStatusText && (d.useStatusText.includes('运行') || d.useStatusText.includes('使用')));
      if (isRunning) {
        if (this.isManualShutdown(d.desktopCode) || this.isManualShutdown(d.desktopId)) {
          this.setManualShutdown(d.desktopCode, false);
          this.setManualShutdown(d.desktopId, false);
          this.logger.addLog('info', `[${accountName} - ${d.desktopName || d.desktopCode}] 检测到云电脑在外部已开机启动，自动解除本地手动关机标记`);
        }
      }

      const old = oldDesktopsMap.get(d.desktopId);
      const resState: ManagedDesktopState = {
        desktopId: d.desktopId,
        desktopName: d.desktopName,
        desktopCode: d.desktopCode,
        useStatusText: d.useStatusText,
        imageName: d.imageName || '',
        flavorName: d.flavorName || d.desktopName || '',
        status: old?.status || 'idle',
        lastHeartbeat: typeof old?.lastHeartbeat === 'string' ? old.lastHeartbeat : undefined,
      };
      return resState;
    });

    // 【关键落盘缓存】：将云电脑列表快照持久化同步回写至 accounts.json
    acc.desktops = state.desktops.map((d) => ({
      desktopId: d.desktopId,
      desktopName: d.desktopName,
      desktopCode: d.desktopCode,
      useStatusText: d.useStatusText,
      imageName: d.imageName,
      flavorName: d.flavorName,
      status: d.status,
      lastHeartbeat: d.lastHeartbeat,
    }));
    this.saveToDisk();

    // 检查是否开启了保活长连接 (由 autoStart 控制)
    const isKeepAliveEnabled = acc.autoStart !== false;
    if (!isKeepAliveEnabled) {
      this.keepaliveService.stopWorkers(accountName);
      for (const d of state.desktops) {
        d.status = 'stopped';
      }
      return;
    }

    await this.keepaliveService.syncWorkersForAccount(
      accountName,
      client,
      list,
      state.desktops,
      (dId) => this.isManualShutdown(dId),
    );
  }

  public async addOrUpdateAccount(config: AccountConfig): Promise<void> {
    const user = config.loginInfo?.mobilephone || config.user;
    const name = config.name || user;
    const deviceCode = config.deviceCode || Config.resolveDeviceCode(name);
    const existingAcc = this.getAccount(config.id || name);
    const id = config.id || existingAcc?.id || crypto.randomUUID();
    const taskConfig = config.taskConfig || existingAcc?.taskConfig || {
      enabled: true,
      aiChat: true,
    };
    const redeemConfig = config.redeemConfig || { ...DEFAULT_REDEEM_CONFIG };
    const fullAcc: AccountConfig = { ...config, id, name, user, deviceCode, taskConfig, redeemConfig };
    delete fullAcc.password;
    delete fullAcc.rawPassword;

    this.accounts.set(name, fullAcc);
    let state = this.accountStates.get(name);
    if (!state) {
      state = {
        id,
        name,
        user,
        deviceCode,
        status: config.loginInfo ? 'online' : 'login_needed',
        loginInfo: config.loginInfo,
        taskConfig,
        redeemConfig,
        desktops: existingAcc?.desktops || [],
      };
      this.accountStates.set(name, state);
    } else {
      state.id = id;
      state.name = name;
      state.user = user;
      state.deviceCode = deviceCode;
      state.taskConfig = taskConfig;
      state.redeemConfig = redeemConfig;
      if (config.loginInfo) {
        state.loginInfo = config.loginInfo;
        state.status = 'online';
      }
    }

    const client = this.getClient(name);
    if (config.loginInfo) {
      client.loginInfo = config.loginInfo;
    }

    this.saveToDisk();
    this.notifyStatusChange();

    if (config.loginInfo) {
      // 异步在后台并行同步积分，云电脑列表与保活由调用方或生命周期按需拉取，防止重复触发
      void (async () => {
        try {
          await this.getPointsAndTasks(name);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.addLog('warn', `[${name}] 后台同步提示: ${msg}`);
        } finally {
          this.notifyStatusChange();
        }
      })();
    }
  }

  public removeAccount(name: string): void {
    this.powerTracker.clearForAccount(name);
    // 2. 停止该账号下的所有保活信道与心跳 Worker
    this.keepaliveService.stopWorkers(name);
    // 3. 清理该账号下的休眠自愈看门狗定时器
    this.watchdogService.stopWatchdogsForAccount(name);
    // 4. 清理今日积分与告警缓存
    this.todayPointsCache.delete(name);
    this.expiredNotifiedAccounts.delete(name);
    this.reloadDesktopsPromises.delete(name);
    this.accounts.delete(name);
    this.clients.delete(name);
    this.accountStates.delete(name);
    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${name}] 账号已移除`);
  }

  public async manualAiChat(accountName: string): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法执行AI对话');
    }
    const res = await AiChatTask.execute(client);
    this.logger.addLog('success', `[${accountName}] AI对话: ${res.message}`);
    setTimeout(() => {
      this.getPointsAndTasks(accountName)
        .then(() => this.notifyStatusChange())
        .catch(() => {});
    }, 2000);
    return res.message;
  }

  public async manualRedeem(
    accountName: string,
    prodId?: number,
    costPoints?: number,
    prodType?: string,
    desktopId?: string,
  ): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法兑换');
    }

    const rConf: RedeemConfig = {
      enabled: acc.redeemConfig?.enabled ?? false,
      scheduleType: acc.redeemConfig?.scheduleType ?? 'interval_days',
      ...acc.redeemConfig,
    };
    let targetDesktopId = desktopId || rConf.targetDesktopId;
    let state = this.accountStates.get(accountName);
    if ((!state?.desktops || state.desktops.length === 0) && (!targetDesktopId || targetDesktopId === 'undefined')) {
      // 若内存中暂无桌面，尝试从官方拉取一次最新的桌面列表
      try {
        await this.reloadDesktops(accountName);
        state = this.accountStates.get(accountName);
      } catch {}
    }

    if (!targetDesktopId) {
      targetDesktopId = state?.desktops?.[0]?.desktopId;
    } else {
      // 兼容支持传入 desktopCode 反查底层数字 desktopId
      const matched = state?.desktops?.find(
        (d) => d.desktopCode === targetDesktopId || String(d.desktopId) === String(targetDesktopId),
      );
      if (matched) {
        targetDesktopId = matched.desktopId;
      } else {
        const fallback = this.findDesktopByCode(targetDesktopId);
        if (fallback) {
          targetDesktopId = fallback.desktop.desktopId;
        }
      }
    }

    const res = await RewardRedeemService.placeOrder(
      client,
      targetDesktopId,
      prodId || rConf.targetProdId,
      costPoints || rConf.costPoints,
      prodType || rConf.prodType,
    );

    const today = getCstDateString();
    rConf.lastRedeemDate = today;
    acc.redeemConfig = rConf;
    this.saveToDisk();
    this.logger.addLog('success', `[${accountName}] ${res.message}`);
    return res.message;
  }

  public async getAvailableRewards(accountName?: string, forceRefresh = false): Promise<RewardItem[]> {
    // 若未指定账号，尝试挑一个已登录的可用账号用于请求天翼云接口
    const targetAccount = accountName || Array.from(this.accounts.keys()).find((k) => !!this.getClient(k).loginInfo);

    // 只要有可用账号，优先尝试从官方接口拉取/刷新一次（带有本地降级保护）
    if (targetAccount && (forceRefresh || !this.rewardsCache || this.rewardsCache.length === 0)) {
      try {
        const client = this.getClient(targetAccount);
        if (client && client.loginInfo) {
          const fetched = await RewardRedeemService.getAvailableRewards(client);
          if (fetched && fetched.length > 0) {
            this.rewardsCache = fetched;
            safeWriteFileSync(Config.rewardsFile, JSON.stringify(this.rewardsCache, null, 2));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.addLog('warn', `获取在线积分商品列表失败，回退使用本地缓存: ${msg}`);
      }
    }
    // 若没有缓存则返回本地预设
    return this.rewardsCache && this.rewardsCache.length > 0 ? this.rewardsCache : DEFAULT_LOCAL_REWARDS;
  }

  public async getPointsAndTasks(accountName: string): Promise<PointsSummary> {
    const client = this.getClient(accountName);
    const summary = await PointsTask.getPointsAndTasks(client);
    let todayEarned = 0;
    for (const t of summary.tasks) {
      if (t.isCompleted) {
        todayEarned += Number(t.rewardPoints || 0);
      }
    }
    const todayStr = getCstDateString();
    this.todayPointsCache.set(accountName, { todayPoints: todayEarned, date: todayStr, summary, updatedAt: Date.now() });
    const state = this.accountStates.get(accountName);
    if (state) {
      state.todayPoints = todayEarned;
    }

    // 智能同步日常任务完成状态：若官方显示日常任务均已达成，同步标记 lastRunDate 防止调度器误判补跑
    const acc = this.accounts.get(accountName);
    if (acc && acc.taskConfig) {
      const chatTask = summary.tasks.find((t) => t.type === 'chat');
      const isChatDone = !chatTask || chatTask.isCompleted || (chatTask.totalProgress > 0 && chatTask.currentProgress >= chatTask.totalProgress);

      if (isChatDone && acc.taskConfig.lastRunDate !== todayStr) {
        acc.taskConfig.lastRunDate = todayStr;
        this.saveToDisk();
      }
    }

    return summary;
  }

  public exportConfigSafe() {
    const sysData = {
      adminPassword: this.adminPassword,
      keepAliveSeconds: this.keepAliveSeconds,
      webhookUrl: this.webhookUrl,
    };
    return this.repository.exportConfigSafe(sysData, this.accounts);
  }

  public importConfigSafe(data: unknown): { importedAccounts: number } {
    const sysData = {
      adminPassword: this.adminPassword,
      keepAliveSeconds: this.keepAliveSeconds,
      webhookUrl: this.webhookUrl,
    };
    const res = this.repository.importConfigSafe(data, sysData, this.accounts);
    if (res.updatedSystem.keepAliveSeconds !== undefined) {
      this.keepAliveSeconds = res.updatedSystem.keepAliveSeconds;
    }
    if (res.updatedSystem.webhookUrl !== undefined) {
      this.webhookUrl = res.updatedSystem.webhookUrl;
    }
    this.saveToDisk();
    return { importedAccounts: res.importedAccounts };
  }

  public saveToDisk(immediate = false): void {
    const sysData = {
      adminPassword: this.adminPassword,
      keepAliveSeconds: this.keepAliveSeconds,
      webhookUrl: this.webhookUrl,
    };
    this.repository.saveToDisk(sysData, this.accounts, this.rewardsCache, immediate);
  }

  public loadFromDisk(): void {
    const data = this.repository.loadConfig();
    this.adminPassword = data.system.adminPassword || '';
    this.keepAliveSeconds = data.system.keepAliveSeconds || 60;
    this.webhookUrl = data.system.webhookUrl || '';
    this.rewardsCache = data.rewards;
    this.accounts = data.accounts;

    for (const [name, acc] of this.accounts.entries()) {
      const client = this.getClient(name);
      if (acc.loginInfo) {
        client.loginInfo = acc.loginInfo;
      }

      const desktops = Array.isArray(acc.desktops) ? acc.desktops : [];
      const state: ManagedAccount = {
        id: acc.id || crypto.randomUUID(),
        name,
        user: acc.user,
        deviceCode: acc.deviceCode || client.getDeviceCode(),
        status: acc.loginInfo ? 'online' : 'login_needed',
        loginInfo: acc.loginInfo,
        taskConfig: acc.taskConfig,
        redeemConfig: acc.redeemConfig,
        desktops: desktops.map((d: ManagedDesktopState) => ({
          desktopId: d.desktopId,
          desktopName: d.desktopName,
          desktopCode: d.desktopCode,
          useStatusText: d.useStatusText || '空闲',
          imageName: d.imageName || '',
          flavorName: d.flavorName || d.desktopName || '',
          status: 'idle',
          lastHeartbeat: typeof d.lastHeartbeat === 'string' ? d.lastHeartbeat : undefined,
        })),
      };
      this.accountStates.set(name, state);
    }

    this.saveToDisk();
    this.logger.addLog('info', `已加载本地配置文件 (${this.accounts.size} 个账号)`);

    let delayMs = 0;
    for (const [name, acc] of this.accounts.entries()) {
      if (acc.loginInfo && acc.autoStart !== false) {
        const staggerDelay = delayMs;
        delayMs += 800; // 每个账号错峰 800ms 启动，防止瞬时并发冲击天翼云接口
        setTimeout(() => {
          this.reloadDesktops(name).catch((err) => {
            this.logger.addLog('warn', `[${name}] 自启动保活提示: ${err.message}`);
          });
          // 服务启动加载时自动拉取一次今日积分数据
          this.getPointsAndTasks(name)
            .then(() => this.notifyStatusChange())
            .catch(() => {});
        }, staggerDelay);
      }
    }
  }
}
