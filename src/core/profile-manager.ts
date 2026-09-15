import fs from 'node:fs';
import crypto from 'node:crypto';
import { Config, getRandomScheduleTime, DEFAULT_REDEEM_CONFIG, type AccountConfig, type TaskConfig, type RedeemConfig } from '../config.js';
import { CtYunClient, type Desktop, type DesktopInfo, type LoginInfo } from './client.js';
import { KeepaliveService, type ManagedDesktopState } from '../modules/keepalive/index.js';
import { Logger, type LogItem } from './logger.js';
import { TaskScheduler } from '../modules/strategy/index.js';
import { SignTask, AiChatTask, type PointsSummary } from '../modules/task/index.js';
import { RewardRedeemService, DEFAULT_LOCAL_REWARDS, sortRewards, type RewardItem } from '../modules/reward/index.js';
import { DesktopSessionArbiter } from '../modules/arbiter/desktop-session-arbiter.js';
import { safeWriteFileSync, sendWebhookNotification, getCstDateString, getCstDateTimeString } from './utils.js';
import type { DesktopInstanceSummary } from '../types/index.js';

// 核心常量规范定义
const WATCHDOG_PROBE_INTERVAL_MS = 300000; // 暂停状态下的探针周期: 5 分钟 (300s)
const POWER_TRACKING_INTERVAL_MS = 20000;  // 电源操作后的轮询追踪周期: 20 秒
const POWER_TRACKING_MAX_ROUNDS = 15;      // 电源状态轮询最大轮次 (15 * 20s = 5 分钟超时)
const SAVE_CONFIG_DEBOUNCE_MS = 150;       // 配置落盘防抖延迟: 150 毫秒
const WEB_RELEASE_DEFAULT_DELAY_SEC = 20;  // Web 直连释放后的默认宽限恢复时间: 20 秒 (给页面刷新和前台切换留足缓冲)

export interface ManagedAccount {
  id: string; // 全局唯一不可变 UUID (主键)
  name: string; // 展示备注名
  user: string;
  deviceCode: string;
  status: 'idle' | 'login_needed' | 'need_sms' | 'online' | 'error';
  lastError?: string;
  loginInfo?: LoginInfo;
  autoStart?: boolean;
  autoSign?: boolean;
  lastSignDate?: string;
  taskConfig?: TaskConfig;
  redeemConfig?: RedeemConfig;
  todayPoints?: number;
  desktops: ManagedDesktopState[];
}

/**
 * 账号与系统顶层业务管理者
 * 协调：账号认证存储、保活服务 (KeepaliveService)、定时调度器 (TaskScheduler)
 */
export class ProfileManager {
  private accounts: Map<string, AccountConfig> = new Map();
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private clients: Map<string, CtYunClient> = new Map();
  private accountStates: Map<string, ManagedAccount> = new Map();
  private logger: Logger = new Logger();
  private keepaliveService: KeepaliveService;
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
  // 电源操作异步状态轮询定时器追踪 (按 desktopCode 跟踪，防止重复轮询及账户卸载后野定时器)
  private powerTrackingTimers: Map<string, NodeJS.Timeout> = new Map();
  // 暂停状态下看门狗定时器 (按 accountName:desktopId 跟踪，每 5 分钟轮询一次 useStatusText，脱离运行中后唤醒并恢复保活)
  private pauseWatchdogTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.keepaliveService = new KeepaliveService(this.logger, () => this.notifyStatusChange());
    this.taskScheduler = new TaskScheduler(this, this.logger);
    this.loadFromDisk();
    this.taskScheduler.start();

    // 租约释放协同：当前台直连释放桌面租约时，自动唤醒保活通道无缝恢复
    const arbiter = DesktopSessionArbiter.getInstance();
    arbiter.setLogger(this.logger);
    arbiter.setResolver((identifier: string) => {
      const matched = this.findDesktopByCode(identifier);
      if (matched) {
        const canonicalCode = matched.desktop.desktopCode || String(matched.desktop.desktopId);
        const dName = matched.desktop.desktopName || matched.desktop.computerName || matched.desktop.name || canonicalCode;
        const displayName = `${matched.accountName} - ${dName}`;
        return {
          canonicalCode,
          displayName,
          accountName: matched.accountName,
          desktopName: dName,
        };
      }
      return undefined;
    });

    // 注册真实状态探测器：在避让期满前，主动向天翼云官方发起轻量状态查询
    arbiter.setStateChecker(async (identifier: string) => {
      const matched = this.findDesktopByCode(identifier);
      if (!matched) return null;
      const client = this.clients.get(matched.accountName);
      if (!client) return null;
      try {
        const objType = typeof matched.desktop.objType === 'number' ? matched.desktop.objType : 0;
        const state = await client.getDesktopState(matched.desktop.desktopId, objType);
        if (!state) return null;
        // 天翼云标准：useStatus 为 '25' 表示外部客户端连接使用中；'20' 为运行中空闲
        const isOccupied = String(state.useStatus) === '25';
        return {
          occupied: isOccupied,
          useStatus: state.useStatus,
        };
      } catch {
        return null;
      }
    });

    arbiter.on('lease:released', ({ purpose, ownerId }) => {
      if (purpose === 'web_direct') {
        const acc = this.accounts.get(ownerId);
        if (acc && acc.autoStart !== false) {
          this.keepaliveService.resumeWorkers(ownerId);
        }
      }
    });

    // 外部避让期结束协同：当外部客户端避让期自然过期或被主动清除时，唤醒保活通道安全恢复
    const onYieldEnded = async (desktopId: string) => {
      const matched = this.findDesktopByCode(desktopId);
      if (matched?.accountName) {
        const acc = this.accounts.get(matched.accountName);
        if (acc && acc.autoStart !== false) {
          await this.keepaliveService.resumeWorkerForDesktop(matched.accountName, desktopId);
        }
      }
      this.notifyStatusChange();
    };

    arbiter.on('yield:expired', ({ desktopId }) => onYieldEnded(desktopId));
    arbiter.on('yield:cleared', ({ desktopId }) => onYieldEnded(desktopId));
    arbiter.on('yield:triggered', () => {
      this.notifyStatusChange();
    });

    // 监听保活服务派发的桌面进入 paused 事件，启动轻量 HTTP 休眠自愈看门狗
    this.keepaliveService.on('desktop:paused', ({ accountName, desktopId }) => {
      this.startPauseWatchdog(accountName, desktopId);
    });
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

  private webReleaseTimers = new Map<string, NodeJS.Timeout>();

  public touchWebUserActive(accountName: string, desktopCode: string, durationSec: number = 60): void {
    const matched = this.findDesktopByCode(desktopCode);
    const matchedAccount = accountName || matched?.accountName || this.getAccountNameByDesktopCode(desktopCode);
    if (!matchedAccount) return;
    
    // 如果存在待延迟释放的计时器（例如用户刷新网页），立即取消该释放任务
    const canonicalKey = matched?.desktop?.desktopCode || desktopCode;
    if (this.webReleaseTimers.has(canonicalKey)) {
      clearTimeout(this.webReleaseTimers.get(canonicalKey)!);
      this.webReleaseTimers.delete(canonicalKey);
    }

    // 1. 立即暂停该单台云电脑的后台保活长连接，并清理看门狗（若存在）
    this.keepaliveService.pauseWorkerForDesktop(matchedAccount, canonicalKey);
    const matchedId = matched?.desktop?.desktopId || canonicalKey;
    this.clearPauseWatchdog(matchedAccount, String(matchedId));
    if (matched?.desktop?.desktopCode) {
      this.clearPauseWatchdog(matchedAccount, String(matched.desktop.desktopCode));
    }

    // 2. 仲裁器注册 Web 直连高优先级租约（带 TTL 自动防死锁），驱逐后台长连接
    const arbiter = DesktopSessionArbiter.getInstance();
    const ttlMs = Math.max(30, Number(durationSec) || 60) * 1000;
    arbiter.acquireLease(canonicalKey, 'web_direct', matchedAccount, async () => {}, ttlMs).catch(() => {});
  }

  public releaseWebUserActive(accountName: string, desktopCode: string, delaySec: number = WEB_RELEASE_DEFAULT_DELAY_SEC): void {
    const matched = this.findDesktopByCode(desktopCode);
    const matchedAccount = accountName || matched?.accountName || this.getAccountNameByDesktopCode(desktopCode);
    if (!matchedAccount) return;
    
    const canonicalKey = matched?.desktop?.desktopCode || desktopCode;

    // 清理可能存在的旧延迟释放任务
    if (this.webReleaseTimers.has(canonicalKey)) {
      clearTimeout(this.webReleaseTimers.get(canonicalKey)!);
      this.webReleaseTimers.delete(canonicalKey);
    }

    // 引入延迟释放宽限期（默认 20 秒）：
    // 浏览器用户刷新网页时会触发 beforeunload 发送 web-close，但 1~2 秒后新页面就会加载并发送 web-active。
    // 宽限期到期后，精准恢复该单台云电脑的保活 Worker
    const timer = setTimeout(async () => {
      this.webReleaseTimers.delete(canonicalKey);

      const arbiter = DesktopSessionArbiter.getInstance();
      arbiter.releaseLease(canonicalKey, 'web_direct', matchedAccount).catch(() => {});

      // 关键恢复：前台直连关闭且宽限期到期后，精准恢复单台云电脑保活 Worker 运行
      const acc = this.accounts.get(matchedAccount);
      if (acc && acc.autoStart !== false) {
        await this.keepaliveService.resumeWorkerForDesktop(matchedAccount, canonicalKey);
      }
    }, Math.max(1, delaySec) * 1000);

    this.webReleaseTimers.set(canonicalKey, timer);
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

  /**
   * 凭证对外脱敏处理 (剔除 secretKey, password, clientKey 等高敏字段)
   */
  public sanitizeLoginInfo(info?: LoginInfo): LoginInfo | undefined {
    if (!info) return undefined;
    const clone = { ...info } as Record<string, unknown>;
    delete clone.secretKey;
    delete clone.clientKey;
    delete clone.caCert;
    delete clone.clientCert;
    delete clone.password;
    delete clone.rawPassword;
    return clone as unknown as LoginInfo;
  }

  /**
   * 账号对外脱敏只读视图 (完全深拷贝隔离内部引用，杜绝污染与凭证泄露)
   */
  public sanitizeAccount(accountOrState: ManagedAccount | AccountConfig): ManagedAccount;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined {
    if (!accountOrState) return undefined;
    let clone: Record<string, unknown>;
    try {
      clone = structuredClone(accountOrState) as unknown as Record<string, unknown>;
    } catch {
      clone = JSON.parse(JSON.stringify(accountOrState)) as unknown as Record<string, unknown>;
    }
    if ('password' in clone) delete clone.password;
    if ('rawPassword' in clone) delete clone.rawPassword;
    if (clone.loginInfo && typeof clone.loginInfo === 'object') {
      const li = clone.loginInfo as Record<string, unknown>;
      delete li.secretKey;
      delete li.clientKey;
      delete li.caCert;
      delete li.clientCert;
      if ('password' in li) delete li.password;
      if ('rawPassword' in li) delete li.rawPassword;
    }
    return clone as unknown as ManagedAccount;
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
            autoSign: true,
            aiChat: true,
            scheduleTime: getRandomScheduleTime(),
          };
        } else if (!acc.taskConfig.scheduleTime) {
          acc.taskConfig.scheduleTime = getRandomScheduleTime();
        }
        state.autoStart = acc.autoStart;
        state.autoSign = acc.autoSign ?? false;
        state.lastSignDate = acc.lastSignDate;
        state.taskConfig = acc.taskConfig;
        state.redeemConfig = acc.redeemConfig;
        const pts = this.todayPointsCache.get(name);
        const todayStr = getCstDateString();
        // 严格自然日校验：仅在缓存日期与东八区当天一致时有效，跨天直接归零
        state.todayPoints = (pts && pts.date === todayStr) ? (pts.todayPoints ?? 0) : 0;
      }
    }
    const arbiter = DesktopSessionArbiter.getInstance();
    return Array.from(this.accountStates.values()).map((state) => {
      const sanitized = this.sanitizeAccount(state);
      if (sanitized.desktops && Array.isArray(sanitized.desktops)) {
        sanitized.desktops = sanitized.desktops.map((d: ManagedDesktopState) => {
          const yieldStatus = arbiter.getYieldStatus(d.desktopCode || String(d.desktopId));
          return {
            ...d,
            yieldStatus: yieldStatus.yielding ? yieldStatus : undefined,
          };
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
    this.clearPauseWatchdogsForAccount(accountName);

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
    this.clearPauseWatchdogsForAccount(accountName);

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
    for (const [, timer] of this.powerTrackingTimers.entries()) {
      clearInterval(timer);
    }
    this.powerTrackingTimers.clear();
    for (const [, timer] of this.pauseWatchdogTimers.entries()) {
      clearInterval(timer);
    }
    this.pauseWatchdogTimers.clear();
    for (const [, timer] of this.webReleaseTimers.entries()) {
      clearTimeout(timer);
    }
    this.webReleaseTimers.clear();
    DesktopSessionArbiter.getInstance().clearAll();
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
      this.trackDesktopStatusAfterPower(accountName, canonicalDesktopCode, trackTarget);
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

  /**
   * 启动暂停状态下的 5 分钟（300s）轻量 HTTP 看门狗探针
   * 探测 useStatusText，若脱离“运行中”（虚拟机休眠或关机），自动触发开机唤醒并恢复保活长连
   */
  private startPauseWatchdog(accountName: string, desktopId: string): void {
    const key = `${accountName}:${desktopId}`;
    if (this.pauseWatchdogTimers.has(key)) return;

    const matched = this.findDesktopByCode(desktopId);
    const dPrefix = matched?.desktop ? `${accountName} - ${matched.desktop.desktopName || matched.desktop.desktopCode}` : accountName;
    this.logger.addLog('info', `[${dPrefix}] 官方客户端在线，后台长连接暂停让位 (启动 5 分钟休眠看门狗探针)`);

    const timer = setInterval(async () => {
      try {
        const acc = this.accounts.get(accountName);
        const state = this.accountStates.get(accountName);
        if (!acc || !state) {
          this.clearPauseWatchdog(accountName, desktopId);
          return;
        }

        // 查找目标桌面
        const target = state.desktops.find(
          (item: ManagedDesktopState) => String(item.desktopId) === String(desktopId) || String(item.desktopCode) === String(desktopId),
        );
        if (!target) {
          this.clearPauseWatchdog(accountName, desktopId);
          return;
        }

        // 若当前桌面已不在 paused 状态（例如被手动启动或彻底停止），退出看门狗
        if (target.status !== 'paused') {
          this.clearPauseWatchdog(accountName, desktopId);
          return;
        }

        const client = this.getClient(accountName);
        if (!client.loginInfo) return;

        // 通过轻量 getDesktopState / getDesktopList 查询官方实时状态
        const objType = typeof target?.objType === 'number' ? target.objType : 0;
        let realStatusText = '';
        let isSessionActive = true;

        try {
          const stateInfo = await client.getDesktopState(desktopId, objType);
          if (stateInfo) {
            realStatusText = stateInfo.useStatusText || '';
            // useStatus 20 表示未连接/无活跃会话
            if (String(stateInfo.useStatus) === '20' || String(stateInfo.desktopState) === '20') {
              isSessionActive = false;
            }
          }
        } catch {}

        if (!realStatusText) {
          const pageRes = await client.getDesktopList();
          const matched = pageRes?.find(
            (item: Desktop) => String(item.desktopId) === String(desktopId) || String(item.desktopCode) === String(desktopId),
          );
          if (!matched) return;
          realStatusText = matched.useStatusText || '';
          if (String(matched.useStatus) === '20' || String(matched.status) === '20') {
            isSessionActive = false;
          }
        }

        target.useStatusText = realStatusText;
        this.notifyStatusChange();

        // 若云电脑脱离活跃运行态（检测到关机、休眠、状态 20 等），立即自动自愈唤醒并恢复长连
        const isNotRunning = !realStatusText.includes('运行') && !realStatusText.includes('使用');
        if (!isSessionActive || isNotRunning) {
          this.logger.addLog(
            'info',
            `[${accountName} - ${target.desktopName || target.desktopCode}] 看门狗检测到云电脑脱离外部活跃占用 (${realStatusText || '无活跃会话'})，触发自动恢复保活...`,
          );

          // 清除看门狗定时器
          this.clearPauseWatchdog(accountName, desktopId);

          // 自动调用开机唤醒（若关机/休眠）
          try {
            await client.operateDesktop(target.desktopCode || desktopId, 'on');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.addLog('warn', `[${accountName}] 自愈开机指令提示: ${msg}`);
          }

          // 恢复保活状态并唤醒 Worker 长连
          acc.autoStart = true;
          this.saveToDisk();
          state.status = 'online';
          target.status = 'connecting';
          this.notifyStatusChange();

          // 缓冲 3 秒等端口就绪后精准恢复长连
          setTimeout(async () => {
            await this.keepaliveService.resumeWorkerForDesktop(accountName, target.desktopCode || desktopId);
          }, 3000);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.addLog('warn', `[${accountName}] 看门狗探针检测异常: ${msg}`);
      }
    }, WATCHDOG_PROBE_INTERVAL_MS);

    this.pauseWatchdogTimers.set(key, timer);
  }

  private clearPauseWatchdog(accountName: string, desktopId: string): void {
    const key = `${accountName}:${desktopId}`;
    const timer = this.pauseWatchdogTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.pauseWatchdogTimers.delete(key);
    }
  }

  private clearPauseWatchdogsForAccount(accountName: string): void {
    const prefix = `${accountName}:`;
    for (const [key, timer] of this.pauseWatchdogTimers.entries()) {
      if (key.startsWith(prefix)) {
        clearInterval(timer);
        this.pauseWatchdogTimers.delete(key);
      }
    }
  }

  /**
   * 电源操作（开机/关机/重启）后异步轮询官方最新真实状态
   */
  private trackDesktopStatusAfterPower(
    accountName: string,
    desktopId: string,
    operation: 'on' | 'shutdown' | 'reset',
  ): void {
    const trackingKey = `${accountName}:${desktopId}`;
    const existingTimer = this.powerTrackingTimers.get(trackingKey);
    if (existingTimer) {
      clearInterval(existingTimer);
      this.powerTrackingTimers.delete(trackingKey);
    }

    const client = this.getClient(accountName);
    let attempts = 0;
    const maxAttempts = POWER_TRACKING_MAX_ROUNDS; // 官方标准: 20s 一次轮询，最长 5 分钟 (15 次)

    const timer = setInterval(async () => {
      attempts++;
      try {
        if (!this.accounts.has(accountName)) {
          clearInterval(timer);
          this.powerTrackingTimers.delete(trackingKey);
          return;
        }

        const state = this.accountStates.get(accountName);
        const target = state?.desktops.find((d) => String(d.desktopCode) === String(desktopId) || String(d.desktopId) === String(desktopId));

        // 优先使用官方轻量级毫秒级接口 getDesktopState 查询最新真实运行状态 (避免全量列表延迟)
        const objType = typeof target?.objType === 'number' ? target.objType : 0;
        const stateInfo = await client.getDesktopState(desktopId, objType);
        let realStatusText = stateInfo?.useStatusText;

        if (!realStatusText) {
          const list = await client.getDesktopList();
          const current = list.find((d) => String(d.desktopCode) === String(desktopId) || String(d.desktopId) === String(desktopId));
          realStatusText = current?.useStatusText;
        }

        if (realStatusText && target) {
          const dName = target.desktopName || target.computerName || target.name || desktopId;
          const dPrefix = dName ? `${accountName} - ${dName}` : accountName;
          target.useStatusText = realStatusText;

          if (operation === 'on' || operation === 'reset') {
            if (realStatusText === '运行中') {
              clearInterval(timer);
              this.powerTrackingTimers.delete(trackingKey);
              target.status = 'connecting';
              this.logger.addLog('success', `[${dPrefix}] 云电脑已成功开机，正在接入保活...`);
              this.notifyStatusChange();
              // 云电脑开机成功后，若账号处于保活状态，缓冲 2 秒后接入 WebSocket 保活，确保官方推流端口与网关完全就绪
              setTimeout(() => {
                this.reloadDesktops(accountName).catch(() => {});
              }, 2000);
              return;
            }
          } else if (operation === 'shutdown') {
            if (realStatusText === '已关机' || realStatusText === '关机') {
              clearInterval(timer);
              this.powerTrackingTimers.delete(trackingKey);
              target.status = 'stopped';
              this.logger.addLog('info', `[${dPrefix}] 云电脑已安全关机，已锁定保活防止误唤醒`);
              this.notifyStatusChange();
              return;
            }
          }
          this.notifyStatusChange();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.addLog('warn', `[${accountName}] 电源状态轮询跟踪网络异常: ${msg}`);
      }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        this.powerTrackingTimers.delete(trackingKey);
        // 超时后执行一次全量刷新校准
        this.reloadDesktops(accountName).catch(() => {});
      }
    }, POWER_TRACKING_INTERVAL_MS);

    this.powerTrackingTimers.set(trackingKey, timer);
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
    this.clearPauseWatchdogsForAccount(realOldName);
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

    // 迁移该账号正在跟踪的电源状态轮询定时器键名
    for (const [key, timer] of Array.from(this.powerTrackingTimers.entries())) {
      if (key.startsWith(`${realOldName}:`)) {
        const desktopId = key.slice(realOldName.length + 1);
        this.powerTrackingTimers.delete(key);
        this.powerTrackingTimers.set(`${trimmed}:${desktopId}`, timer);
      }
    }

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
      autoSign: true,
      aiChat: true,
      scheduleTime: getRandomScheduleTime(),
    };
    if (!taskConfig.scheduleTime) {
      taskConfig.scheduleTime = getRandomScheduleTime();
    }
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
        autoSign: config.autoSign ?? true,
        lastSignDate: config.lastSignDate,
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
    // 1. 清理该账号正在跟踪的电源状态轮询定时器
    for (const [key, timer] of this.powerTrackingTimers.entries()) {
      if (key.startsWith(`${name}:`)) {
        clearInterval(timer);
        this.powerTrackingTimers.delete(key);
      }
    }
    // 2. 停止该账号下的所有保活信道与心跳 Worker
    this.keepaliveService.stopWorkers(name);
    // 3. 清理该账号下的休眠自愈看门狗定时器
    this.clearPauseWatchdogsForAccount(name);
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
    const summary = await SignTask.getPointsAndTasks(client);
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
        acc.lastSignDate = todayStr;
        this.saveToDisk();
      }
    }

    return summary;
  }

  public exportConfigSafe() {
    return {
      version: '2.2.0',
      exportedAt: new Date().toISOString(),
      system: {
        keepAliveSeconds: this.keepAliveSeconds,
        webhookUrl: this.webhookUrl,
      },
      accounts: Array.from(this.accounts.values()).map((acc) => {
        const sanitized = { ...acc };
        delete sanitized.password;
        delete sanitized.rawPassword;
        return sanitized;
      }),
    };
  }

  public importConfigSafe(data: unknown): { importedAccounts: number } {
    if (!data || typeof data !== 'object') {
      throw new Error('导入的配置文件格式非法');
    }
    const cfg = data as Record<string, unknown>;
    if (cfg.system && typeof cfg.system === 'object') {
      const sys = cfg.system as Record<string, unknown>;
      if (typeof sys.keepAliveSeconds === 'number' && sys.keepAliveSeconds >= 10) {
        this.keepAliveSeconds = sys.keepAliveSeconds;
      }
      if (typeof sys.webhookUrl === 'string') {
        this.webhookUrl = sys.webhookUrl.trim();
      }
    }
    let importedAccounts = 0;
    if (Array.isArray(cfg.accounts)) {
      for (const rawAcc of cfg.accounts) {
        if (!rawAcc || typeof rawAcc !== 'object') continue;
        const acc = rawAcc as Record<string, unknown>;
        if (typeof acc.name !== 'string' || !acc.name) continue;
        const sanitized: AccountConfig = {
          ...(acc as unknown as AccountConfig),
        };
        delete sanitized.password;
        delete sanitized.rawPassword;
        this.accounts.set(sanitized.name, sanitized);
        importedAccounts++;
      }
    }
    this.saveToDisk();
    return { importedAccounts };
  }

  public saveToDisk(immediate = false): void {
    if (immediate) {
      if (this.saveDebounceTimer) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
      }
      this.executeSaveToDisk();
      return;
    }

    if (this.saveDebounceTimer) return;
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.executeSaveToDisk();
    }, SAVE_CONFIG_DEBOUNCE_MS);
  }

  private executeSaveToDisk(): void {
    Config.initDirs();

    // 1. 保存 config.json (系统设置)
    const sysData = {
      system: {
        adminPassword: this.adminPassword,
        keepAliveSeconds: this.keepAliveSeconds,
        webhookUrl: this.webhookUrl,
      },
    };
    safeWriteFileSync(Config.configFile, JSON.stringify(sysData, null, 2));

    // 2. 保存 accounts.json (账号与各账号独立策略配置，严禁任何明文密码或敏感凭据落盘)
    const list: AccountConfig[] = Array.from(this.accounts.values()).map((acc) => {
      const sanitized = { ...acc };
      delete sanitized.password;
      delete sanitized.rawPassword;
      return sanitized;
    });
    safeWriteFileSync(Config.accountsFile, JSON.stringify(list, null, 2));

    // 3. 保存 rewards.json (商品目录本地化独立存储)
    if (this.rewardsCache && this.rewardsCache.length > 0) {
      safeWriteFileSync(Config.rewardsFile, JSON.stringify(this.rewardsCache, null, 2));
    }
  }

  public loadFromDisk(): void {
    Config.initDirs();

    // 1. 加载 config.json (系统设置)
    if (fs.existsSync(Config.configFile)) {
      try {
        const sysContent = fs.readFileSync(Config.configFile, 'utf8');
        const sysJson = JSON.parse(sysContent);
        const sys = sysJson.system || sysJson;
        if (sys.adminPassword !== undefined) this.adminPassword = sys.adminPassword;
        if (sys.keepAliveSeconds) this.keepAliveSeconds = sys.keepAliveSeconds;
        if (sys.webhookUrl !== undefined) this.webhookUrl = sys.webhookUrl;
      } catch {}
    }

    if (process.env.ADMIN_PASSWORD && !this.adminPassword) {
      this.adminPassword = process.env.ADMIN_PASSWORD;
    }

    // 2. 加载 rewards.json (独立商品数据)
    if (fs.existsSync(Config.rewardsFile)) {
      try {
        const rewContent = fs.readFileSync(Config.rewardsFile, 'utf8');
        const rewJson = JSON.parse(rewContent);
        if (Array.isArray(rewJson) && rewJson.length > 0) {
          this.rewardsCache = sortRewards(rewJson);
        }
      } catch {}
    } else {
      // 首次自动写入默认本地化商品目录到 rewards.json
      try {
        this.rewardsCache = sortRewards([...DEFAULT_LOCAL_REWARDS]);
        safeWriteFileSync(Config.rewardsFile, JSON.stringify(this.rewardsCache, null, 2));
      } catch {}
    }

    try {
      // 3. 加载 accounts.json (优先加载独立 accounts.json，亦兼容旧版 config.json 内 accounts 字段迁移)
      let rawAccounts: Partial<AccountConfig>[] = [];
    if (fs.existsSync(Config.accountsFile)) {
      try {
        const accContent = fs.readFileSync(Config.accountsFile, 'utf8');
        const accJson = JSON.parse(accContent);
        if (Array.isArray(accJson)) {
          rawAccounts = accJson;
        } else if (Array.isArray(accJson.accounts)) {
          rawAccounts = accJson.accounts;
        }
      } catch {}
    }

    // 兼容历史遗留：若 accounts.json 为空，检查 config.json 是否含有 accounts
    if (rawAccounts.length === 0 && fs.existsSync(Config.configFile)) {
      try {
        const legacyCfg = JSON.parse(fs.readFileSync(Config.configFile, 'utf8'));
        if (Array.isArray(legacyCfg.accounts)) {
          rawAccounts = legacyCfg.accounts;
        }
        // 兼容历史 legacy rewardsCache
        if (legacyCfg.system?.rewardsCache && (!this.rewardsCache || this.rewardsCache.length === 0)) {
          this.rewardsCache = legacyCfg.system.rewardsCache;
        }
      } catch {}
    }

    for (const acc of rawAccounts) {
      const user = String(acc.loginInfo?.mobilephone || acc.user || '').trim();
      if (!user) continue;
      let name = String(acc.name || user).trim();
      // 如果此前自动生成的默认名称形如 '用户0130824707'，自动纠偏为手机号码
      if ((name === acc.user || /^用户\d+$/.test(name)) && acc.loginInfo?.mobilephone) {
        name = acc.loginInfo.mobilephone;
      }
      const deviceCode = Config.resolveDeviceCode(name, acc.deviceCode);
      const taskConfig = acc.taskConfig || {
        enabled: true,
        autoSign: true,
        aiChat: true,
        scheduleTime: getRandomScheduleTime(),
      };
      if (!taskConfig.scheduleTime) {
        taskConfig.scheduleTime = getRandomScheduleTime();
      }
      const redeemConfig = acc.redeemConfig || { ...DEFAULT_REDEEM_CONFIG };
      const id = acc.id || crypto.randomUUID();
      const desktops = Array.isArray(acc.desktops) ? acc.desktops : [];
      const fullAcc: AccountConfig = { ...acc, id, name, user, deviceCode, taskConfig, redeemConfig, desktops };
      delete fullAcc.password;
      delete fullAcc.rawPassword;
      this.accounts.set(name, fullAcc);

      const client = this.getClient(name);
      if (acc.loginInfo) {
        client.loginInfo = acc.loginInfo;
      }

      const state: ManagedAccount = {
        id,
        name,
        user,
        deviceCode: acc.deviceCode || client.getDeviceCode(),
        status: acc.loginInfo ? 'online' : 'login_needed',
        loginInfo: acc.loginInfo,
        autoSign: acc.autoSign ?? true,
        lastSignDate: acc.lastSignDate,
        taskConfig,
        redeemConfig,
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

      for (const [name, acc] of this.accounts.entries()) {
        if (acc.loginInfo && acc.autoStart !== false) {
          this.reloadDesktops(name).catch((err) => {
            this.logger.addLog('warn', `[${name}] 自启动保活提示: ${err.message}`);
          });
          // 服务启动加载时自动拉取一次今日积分数据
          this.getPointsAndTasks(name)
            .then(() => this.notifyStatusChange())
            .catch(() => {});
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.addLog('error', `加载配置文件 config.json 失败: ${msg}`);
    }
  }
}
