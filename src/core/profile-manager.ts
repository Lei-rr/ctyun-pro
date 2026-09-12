import fs from 'node:fs';
import crypto from 'node:crypto';
import { Config, getRandomScheduleTime, DEFAULT_REDEEM_CONFIG, type AccountConfig, type TaskConfig, type RedeemConfig } from '../config.js';
import { CtYunClient, type Desktop, type DesktopInfo, type LoginInfo } from './client.js';
import { KeepaliveService, type ManagedDesktopState } from '../modules/keepalive/index.js';
import { Logger, type LogItem } from './logger.js';
import { TaskScheduler } from '../modules/strategy/index.js';
import { isHangTaskName, TaskStrategyService, type PointsSummary } from '../modules/task/index.js';
import { RewardRedeemService, DEFAULT_LOCAL_REWARDS, sortRewards, type RewardItem } from '../modules/reward/index.js';
import { DesktopSessionArbiter } from '../modules/arbiter/desktop-session-arbiter.js';
import { AccountService } from '../modules/account/index.js';
import { safeWriteFileSync, sendWebhookNotification, getCstDateString } from './utils.js';

export interface ManagedAccount {
  id: string; // 全局唯一不可变 UUID (主键)
  name: string; // 展示备注名
  user: string;
  deviceCode: string;
  status: 'idle' | 'login_needed' | 'need_sms' | 'online' | 'error';
  lastError?: string;
  loginInfo?: LoginInfo;
  autoSign?: boolean;
  lastSignDate?: string;
  taskConfig?: any;
  redeemConfig?: any;
  todayPoints?: number;
  hangStatus?: {
    running: boolean;
    currentProgress?: number;
    totalProgress?: number;
    message?: string;
  };
  desktops: ManagedDesktopState[];
}

/**
 * 账号与系统顶层业务管理者
 * 协调：账号认证存储、保活服务 (KeepaliveService)、定时调度器 (TaskScheduler)、任务编排服务 (TaskStrategyService)
 */
export class ProfileManager {
  private accounts: Map<string, AccountConfig> = new Map();
  private clients: Map<string, CtYunClient> = new Map();
  private accountStates: Map<string, ManagedAccount> = new Map();
  private logger: Logger = new Logger();
  private keepaliveService: KeepaliveService;
  private taskScheduler: TaskScheduler;
  private taskStrategyService: TaskStrategyService;
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

  constructor() {
    this.keepaliveService = new KeepaliveService(this.logger, () => this.notifyStatusChange());
    this.taskScheduler = new TaskScheduler(this, this.logger);
    this.taskStrategyService = new TaskStrategyService(this.logger);
    this.loadFromDisk();
    this.taskScheduler.start();
  }

  public getKeepaliveService(): KeepaliveService {
    return this.keepaliveService;
  }

  public getTaskStrategyService(): TaskStrategyService {
    return this.taskStrategyService;
  }

  public getAccountNameByDesktopId(desktopCode: string): string | undefined {
    const codeStr = String(desktopCode).trim();
    for (const [name, state] of this.accountStates.entries()) {
      const d = state.desktops.find((item) => String(item.desktopCode) === codeStr);
      if (d) return name;
    }
    return undefined;
  }

  /**
   * 通过全局唯一 desktopCode 反查账号与桌面实例信息
   */
  public findDesktopById(desktopCode: string): { accountName: string; desktop: ManagedDesktopState } | undefined {
    if (!desktopCode) return undefined;
    const codeStr = String(desktopCode).trim();
    for (const [name, state] of this.accountStates.entries()) {
      const d = state.desktops.find((item) => String(item.desktopCode) === codeStr);
      if (d) {
        return { accountName: name, desktop: d };
      }
    }
    // 兜底查 accounts 原生配置
    for (const [name, acc] of this.accounts.entries()) {
      const d = (acc.desktops || []).find((item: any) => String(item.desktopCode) === codeStr);
      if (d) {
        return { accountName: name, desktop: d as ManagedDesktopState };
      }
    }
    return undefined;
  }

  public touchWebUserActive(accountName: string, desktopCode: string, durationSec: number = 60): void {
    const matchedAccount = accountName || this.getAccountNameByDesktopId(desktopCode);
    if (!matchedAccount) return;
    // 仲裁器注册 Web 直连高优先级租约，驱逐所有后台长连接
    const arbiter = DesktopSessionArbiter.getInstance();
    arbiter.acquireLease(desktopCode, 'web_direct', matchedAccount, async () => {
      // 租约过期回调：无特殊释放操作
    }).catch(() => {});
    // 协同让位：若该账号正在执行后台纯协议挂机，立即主动中止挂机释放推流信道，彻底防止双端互踢冲突
    this.taskStrategyService.stopHang(matchedAccount).catch(() => {});
  }

  public releaseWebUserActive(accountName: string, desktopCode: string): void {
    const matchedAccount = accountName || this.getAccountNameByDesktopId(desktopCode);
    if (!matchedAccount) return;
    const arbiter = DesktopSessionArbiter.getInstance();
    arbiter.releaseLease(desktopCode, 'web_direct', matchedAccount).catch(() => {});
  }

  public isManualShutdown(desktopCode: string): boolean {
    return this.manualShutdownDesktops.has(desktopCode);
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
   * 账号对外脱敏只读视图 (完全深拷贝隔离内部引用，杜绝污染与凭证泄露)
   */
  public sanitizeAccount(accountOrState: any): any {
    return AccountService.sanitizeAccount(accountOrState);
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
            enabled: acc.autoSign ?? true,
            autoSign: true,
            loginDesktop: true,
            aiChat: true,
            keepAliveHang: true,
            scheduleTime: getRandomScheduleTime(),
          };
        } else if (!acc.taskConfig.scheduleTime) {
          acc.taskConfig.scheduleTime = getRandomScheduleTime();
        }
        state.autoSign = acc.autoSign ?? false;
        state.lastSignDate = acc.lastSignDate;
        state.taskConfig = acc.taskConfig;
        state.redeemConfig = acc.redeemConfig;
        state.hangStatus = this.taskStrategyService.getHangInfo(name) || undefined;
        const pts = this.todayPointsCache.get(name);
        const todayStr = getCstDateString();
        // 严格自然日校验：仅在缓存日期与东八区当天一致时有效，跨天直接归零
        state.todayPoints = (pts && pts.date === todayStr) ? (pts.todayPoints ?? 0) : 0;
      }
    }
    return Array.from(this.accountStates.values()).map((state) => this.sanitizeAccount(state));
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
  public getAllInstancesSummary(): any[] {
    const list: any[] = [];
    for (const [name, acc] of this.accounts.entries()) {
      const state = this.accountStates.get(name);
      const desktops = state?.desktops?.length ? state.desktops : (acc.desktops || []);
      for (const d of desktops) {
        const desktopCode = d.desktopCode || d.desktopId;
        list.push({
          id: desktopCode,
          desktopCode,
          desktopName: d.desktopName,
          flavorName: d.flavorName || d.desktopName,
          imageName: d.imageName,
          useStatusText: d.useStatusText || '空闲',
          status: d.status || 'idle',
          lastHeartbeat: d.lastHeartbeat,
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
    this.keepaliveService.stopWorkers(accountName);
    const state = this.accountStates.get(accountName);
    if (state) {
      state.status = 'idle';
      for (const d of state.desktops) {
        d.status = 'stopped';
      }
    }
    this.logger.addLog('warn', `[${accountName}] 保活任务已手动停止`);
    this.notifyStatusChange();
  }

  public async stopAll(): Promise<void> {
    this.taskScheduler.stop();
    this.keepaliveService.stopAll();
    await this.taskStrategyService.destroyAllHang();
    DesktopSessionArbiter.getInstance().clearAll();
    this.saveToDisk();
  }

  public async operateDesktop(
    accountName: string,
    desktopCode: string,
    operation: 'on' | 'shutdown' | 'reset',
  ): Promise<string> {
    const state = this.accountStates.get(accountName);
    const client = this.getClient(accountName);
    const codeStr = String(desktopCode).trim();
    const desktop = state?.desktops.find((item) => String(item.desktopCode) === codeStr);
    if (!state || !desktop || !client.loginInfo) throw new Error('未找到可操作的云电脑或账号未登录');

    const canonicalDesktopCode = desktop.desktopCode;
    const requestApiDesktopId = desktop.desktopId;

    if (operation === 'shutdown' || operation === 'reset') {
      if (operation === 'shutdown') {
        this.setManualShutdown(canonicalDesktopCode, true);
      }
      this.keepaliveService.stopWorkerForDesktop(accountName, canonicalDesktopCode);
      desktop.status = 'stopped';
      desktop.lastHeartbeat = undefined;
      desktop.useStatusText = operation === 'shutdown' ? '已关机' : '重启中';
      this.notifyStatusChange();
    } else {
      this.setManualShutdown(canonicalDesktopCode, false);
      desktop.status = 'connecting';
      desktop.useStatusText = '启动中';
      this.notifyStatusChange();
    }

    try {
      const targetObjType = desktop.objType ?? 0;
      const dName = desktop.desktopName || (desktop as any).computerName || (desktop as any).name || canonicalDesktopCode;
      const dPrefix = dName ? `${accountName} - ${dName}` : accountName;
      const message = await client.operateDesktop(requestApiDesktopId, operation, targetObjType);
      this.logger.addLog('info', `[${dPrefix}] ${message}`);
      // 后台轮询跟踪云电脑电源状态，直至真正开机或关机完成
      this.trackDesktopStatusAfterPower(accountName, canonicalDesktopCode, operation);
      return message;
    } catch (error) {
      desktop.status = 'stopped';
      desktop.useStatusText = '操作失败';
      this.notifyStatusChange();
      throw error;
    }
  }

  /**
   * 生成官方远程桌面免密直达 URL
   */
  public async getDesktopDirectUrl(
    accountName: string,
    desktopId?: string,
  ): Promise<{ url: string; desktopCode?: string }> {
    const state = this.accountStates.get(accountName);
    if (state && desktopId) {
      const d = state.desktops.find((item) => item.desktopId === desktopId || item.desktopCode === desktopId);
      if (d?.desktopCode) {
        return this.getDesktopDirectUrlByDesktopId(d.desktopCode, accountName);
      }
    }
    const client = this.getClient(accountName);
    if (!state || !client || !client.loginInfo) {
      throw new Error('未找到该账号或账号未登录');
    }

    let targetDesktop = desktopId
      ? state.desktops.find((item) => item.desktopId === desktopId || item.desktopCode === desktopId)
      : state.desktops[0];

    // 如果还没有加载过云电脑列表，则刷新一次
    if (!targetDesktop) {
      try {
        await this.reloadDesktops(accountName);
        const updatedState = this.accountStates.get(accountName);
        targetDesktop = desktopId
          ? updatedState?.desktops.find((item) => item.desktopId === desktopId || item.desktopCode === desktopId)
          : updatedState?.desktops[0];
      } catch (err: any) {
        this.logger.addLog('warn', `[${accountName}] 刷新云电脑列表失败: ${err.message}`);
      }
    }

    if (targetDesktop?.desktopCode) {
      return this.getDesktopDirectUrlByDesktopId(targetDesktop.desktopCode, accountName);
    }

    const token = await client.genLoginToken(300);
    const desktopCode = targetDesktop?.desktopCode || '';
    const directUrl = desktopCode
      ? `https://pc.ctyun.cn/#/oauth?token=${encodeURIComponent(token)}&desktopOid=${encodeURIComponent(desktopCode)}`
      : `https://pc.ctyun.cn/#/oauth?token=${encodeURIComponent(token)}`;

    this.logger.addLog('info', `[${accountName}] 生成远程桌面免密直连链接成功 (有效期 5 分钟)`);
    return { url: directUrl, desktopCode };
  }

  /**
   * 通过全局唯一 desktopCode 反查账号与桌面，生成远程桌面免密直连链接（新窗口直接打开官方界面）
   */
  public async getDesktopDirectUrlByDesktopId(
    desktopCode: string,
    accountHint?: string,
  ): Promise<{ url: string; desktopCode?: string; accountName: string }> {
    if (!desktopCode) {
      throw new Error('缺少全局唯一 desktopCode');
    }

    const codeStr = String(desktopCode).trim();
    let matchedAccountName: string | undefined;
    let targetDesktop: ManagedDesktopState | undefined;

    // 1. 如果提供了账号提示，优先快速排查
    if (accountHint) {
      const state = this.accountStates.get(accountHint);
      if (state) {
        const d = state.desktops.find((item) => String(item.desktopCode) === codeStr);
        if (d) {
          matchedAccountName = state.name;
          targetDesktop = d;
        }
      }
    }

    // 2. 全局遍历所有已托管账号的桌面状态进行精准反查
    if (!targetDesktop) {
      for (const [name, state] of this.accountStates.entries()) {
        const d = state.desktops.find((item) => String(item.desktopCode) === codeStr);
        if (d) {
          matchedAccountName = name;
          targetDesktop = d;
          break;
        }
      }
    }

    // 3. 如果内存状态中未命中，尝试全量刷新一次各账号桌面后再查
    if (!targetDesktop) {
      for (const name of this.accounts.keys()) {
        try {
          await this.reloadDesktops(name);
          const state = this.accountStates.get(name);
          const d = state?.desktops.find((item) => String(item.desktopCode) === codeStr);
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

    const client = this.getClient(matchedAccountName);
    if (!client || !client.loginInfo) {
      throw new Error(`云电脑所属账号 [${matchedAccountName}] 未登录或凭据失效`);
    }

    const token = await client.genLoginToken(300);
    const code = targetDesktop.desktopCode || '';
    const directUrl = code
      ? `https://pc.ctyun.cn/#/oauth?token=${encodeURIComponent(token)}&desktopOid=${encodeURIComponent(code)}`
      : `https://pc.ctyun.cn/#/oauth?token=${encodeURIComponent(token)}`;

    this.logger.addLog('info', `[${matchedAccountName}] 生成远程桌面免密直连链接成功 (有效期 5 分钟)`);
    return { url: directUrl, desktopCode: code, accountName: matchedAccountName };
  }

  /**
   * 通过全局唯一 desktopCode 反查账号与桌面，并获取推流直连参数
   * （彻底解决账号重名/改名与同名寻址冲突问题）
   */
  public async getDesktopConnectionParamsByDesktopId(
    desktopCode: string,
    accountHint?: string,
  ): Promise<{
    wsHost: string;
    desktopId: string;
    desktopInfo: any;
    deviceCode: string;
    userAccount: string;
    desktopName?: string;
    accountName: string;
  }> {
    if (!desktopCode) {
      throw new Error('缺少全局唯一 desktopCode');
    }

    const codeStr = String(desktopCode).trim();
    let matchedAccountName: string | undefined;
    let targetDesktop: ManagedDesktopState | undefined;

    // 1. 如果提供了账号提示，优先快速排查
    if (accountHint) {
      const state = this.accountStates.get(accountHint);
      if (state) {
        const d = state.desktops.find((item) => String(item.desktopCode) === codeStr);
        if (d) {
          matchedAccountName = state.name;
          targetDesktop = d;
        }
      }
    }

    // 2. 全局遍历所有已托管账号的桌面状态进行精准反查
    if (!targetDesktop) {
      for (const [name, state] of this.accountStates.entries()) {
        const d = state.desktops.find((item) => String(item.desktopCode) === codeStr);
        if (d) {
          matchedAccountName = name;
          targetDesktop = d;
          break;
        }
      }
    }

    // 3. 如果内存状态中未命中，尝试全量刷新一次各账号桌面后再查
    if (!targetDesktop) {
      for (const name of this.accounts.keys()) {
        try {
          await this.reloadDesktops(name);
          const state = this.accountStates.get(name);
          const d = state?.desktops.find((item) => String(item.desktopCode) === codeStr);
          if (d) {
            matchedAccountName = name;
            targetDesktop = d;
            break;
          }
        } catch {}
      }
    }

    if (!matchedAccountName || !targetDesktop) {
      throw new Error(`全局未找到设备编码为 [${desktopCode}] 的云电脑实例`);
    }

    const client = this.getClient(matchedAccountName);
    if (!client || !client.loginInfo) {
      throw new Error(`云电脑所属账号 [${matchedAccountName}] 未登录或凭据失效`);
    }

    const dId = String(targetDesktop.desktopId);
    const objType = targetDesktop.objType ?? 0;
    const desktopInfo = await client.connectDesktop(dId, objType);

    // 官方 Clink WebSocket 网关地址，格式对齐官方 SDK: wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktopId}
    const hostWithPort = desktopInfo.clinkLvsOutHost
      ? (desktopInfo.clinkLvsOutHost.includes(':') ? desktopInfo.clinkLvsOutHost : `${desktopInfo.clinkLvsOutHost}:9011`)
      : 'deskmsgz.ctyun.cn:9011';
    const gateway = `wss://${hostWithPort}/clinkProxy/${dId}`;

    this.logger.addLog('info', `[${matchedAccountName}] 全局命中云电脑 [${dId}] 直连凭证与推流网关: ${gateway}`);

    return {
      wsHost: gateway,
      desktopId: dId,
      desktopInfo,
      deviceCode: client.getDeviceCode(),
      userAccount: ((client.loginInfo as any)?.account as string) || matchedAccountName,
      desktopName: targetDesktop.desktopName,
      accountName: matchedAccountName,
    };
  }

  /**
   * 电源操作（开机/关机/重启）后异步轮询官方最新真实状态
   */
  private trackDesktopStatusAfterPower(
    accountName: string,
    desktopId: string,
    operation: 'on' | 'shutdown' | 'reset',
  ): void {
    const client = this.getClient(accountName);
    let attempts = 0;
    const maxAttempts = 60; // 最多轮询 5 分钟 (每 5 秒一次)

    const timer = setInterval(async () => {
      attempts++;
      try {
        const list = await client.getDesktopList();
        const current = list.find((d) => String(d.desktopCode) === String(desktopId) || String(d.desktopId) === String(desktopId));
        const state = this.accountStates.get(accountName);
        const target = state?.desktops.find((d) => String(d.desktopCode) === String(desktopId) || String(d.desktopId) === String(desktopId));

        if (current && target) {
          const dName = target.desktopName || (target as any).computerName || (target as any).name || desktopId;
          const dPrefix = dName ? `${accountName} - ${dName}` : accountName;
          target.useStatusText = current.useStatusText;

          if (operation === 'on' || operation === 'reset') {
            if (current.useStatusText === '运行中') {
              clearInterval(timer);
              target.status = 'connecting';
              this.logger.addLog('success', `[${dPrefix}] 云电脑已成功开机，正在接入保活...`);
              this.notifyStatusChange();
              // 云电脑开机成功后，若账号处于保活状态，自动启动该桌面的 WebSocket 保活
              this.reloadDesktops(accountName).catch(() => {});
              return;
            }
          } else if (operation === 'shutdown') {
            if (current.useStatusText === '已关机' || current.useStatusText === '关机') {
              clearInterval(timer);
              target.status = 'stopped';
              this.logger.addLog('info', `[${dPrefix}] 云电脑已安全关机，已锁定保活防止误唤醒`);
              this.notifyStatusChange();
              return;
            }
          }
          this.notifyStatusChange();
        }
      } catch {}

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        // 超时后执行一次全量刷新校准
        this.reloadDesktops(accountName).catch(() => {});
      }
    }, 5000);
  }

  public updateAccountName(oldName: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    if (this.accounts.has(trimmed)) {
      throw new Error(`已存在名为 [${trimmed}] 的账号`);
    }

    const acc = this.accounts.get(oldName);
    if (!acc) throw new Error('未找到该账号');

    const state = this.accountStates.get(oldName);
    const client = this.clients.get(oldName);

    this.keepaliveService.stopWorkers(oldName);
    this.taskStrategyService.renameHangSession(oldName, trimmed);
    this.accounts.delete(oldName);
    this.accountStates.delete(oldName);
    if (client) this.clients.delete(oldName);

    acc.name = trimmed;
    this.accounts.set(trimmed, acc);

    if (state) {
      state.name = trimmed;
      this.accountStates.set(trimmed, state);
    }
    if (client) {
      this.clients.set(trimmed, client);
    }

    const pts = this.todayPointsCache.get(oldName);
    if (pts) {
      this.todayPointsCache.delete(oldName);
      this.todayPointsCache.set(trimmed, pts);
    }

    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${oldName}] 备注名称已修改为 [${trimmed}]`);

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

    this.logger.addLog('info', `[${accountName}] 正在查询云电脑列表...`);
    let list: Desktop[] = [];
    try {
      list = await client.getDesktopList();
    } catch (err: any) {
      state.status = 'error';
      state.lastError = err.message;
      this.logger.addLog('error', `[${accountName}] 拉取云电脑失败: ${err.message}`);

      // 检测是否为 Token 过期或未登录
      const errMsg = (err.message || '').toLowerCase();
      if (
        errMsg.includes('登录') ||
        errMsg.includes('token') ||
        errMsg.includes('401') ||
        errMsg.includes('过期') ||
        errMsg.includes('失效') ||
        errMsg.includes('重新登录')
      ) {
        state.status = 'login_needed';
        if (this.webhookUrl && !this.expiredNotifiedAccounts.has(accountName)) {
          this.expiredNotifiedAccounts.add(accountName);
          const title = `天翼云电脑 - [${accountName}] 登录态失效告警`;
          const content = `账号: ${accountName}\n错误: ${err.message}\n状态: 登录凭证已失效或被踢出，已暂停自动任务。\n请尽快登录 Web 控制台重新扫码登录！`;
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
      const old = oldDesktopsMap.get(d.desktopId);
      return {
        desktopId: d.desktopId,
        desktopName: d.desktopName,
        desktopCode: d.desktopCode,
        useStatusText: d.useStatusText,
        imageName: (d as any).imageName || '',
        flavorName: (d as any).flavorName || (d as any).desktopName || '',
        status: old?.status || 'idle',
        lastHeartbeat: old?.lastHeartbeat,
      };
    });

    // 【关键落盘缓存】：将云电脑列表快照持久化同步回写至 accounts.json
    acc.desktops = state.desktops.map((d) => ({
      desktopId: d.desktopId,
      desktopName: d.desktopName,
      desktopCode: d.desktopCode,
      useStatusText: d.useStatusText,
      imageName: d.imageName,
      flavorName: d.flavorName,
      lastHeartbeat: d.lastHeartbeat,
    }));
    this.saveToDisk();

    // 检查是否开启了保活长连接 (由 autoStart 控制，与挂机做任务完全解耦)
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
      loginDesktop: true,
      aiChat: true,
      keepAliveHang: true,
      scheduleTime: getRandomScheduleTime(),
    };
    if (!taskConfig.scheduleTime) {
      taskConfig.scheduleTime = getRandomScheduleTime();
    }
    const redeemConfig = config.redeemConfig || { ...DEFAULT_REDEEM_CONFIG };
    const fullAcc: AccountConfig = { ...config, id, name, user, deviceCode, taskConfig, redeemConfig };

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
        } catch (e: any) {
          this.logger.addLog('warn', `[${name}] 后台同步提示: ${e.message}`);
        } finally {
          this.notifyStatusChange();
        }
      })();
    }
  }

  public removeAccount(name: string): void {
    this.keepaliveService.stopWorkers(name);
    this.accounts.delete(name);
    this.clients.delete(name);
    this.accountStates.delete(name);
    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${name}] 账号已移除`);
  }

  public async manualRunTasks(accountName: string): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法执行任务');
    }
    const state = this.accountStates.get(accountName);
    const dId = state?.desktops?.[0]?.desktopId;
    const res = await this.taskStrategyService.executeDailyTasks(client, dId, acc.taskConfig, this.logger);
    const today = getCstDateString();
    acc.lastSignDate = today;
    if (!acc.taskConfig) {
      acc.taskConfig = { enabled: true, autoSign: true, scheduleTime: getRandomScheduleTime() };
    }
    acc.taskConfig.lastRunDate = today;
    if (state) {
      state.lastSignDate = today;
      state.taskConfig = acc.taskConfig;
    }
    this.saveToDisk();
    this.logger.addLog('success', `[${accountName}] 每日任务已执行: ${res.message}`);
    this.notifyStatusChange();

    // 执行任务后异步重新核验并更新当日已获积分
    setTimeout(() => {
      this.getPointsAndTasks(accountName)
        .then(() => this.notifyStatusChange())
        .catch(() => {});
    }, 3000);

    // 若配置开启了保活挂机，在后台异步拉起智能补时挂机
    if (acc.taskConfig?.keepAliveHang !== false) {
      this.manualHang(accountName).catch(() => {});
    }

    return res.message;
  }

  public async manualHang(accountName: string): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法挂机');
    }

    if (this.taskStrategyService.isHangRunning(accountName)) {
      return '后台挂机任务已在运行中，无需重复触发';
    }

    // 确保清理残留的旧挂机状态与会话缓存
    this.taskStrategyService.clearHangSession(accountName);

    // 挂机启动前：优先软暂停底层保活连接，无缝让位防踢线
    const paused = this.keepaliveService.pauseWorkers(accountName);
    if (!paused) {
      this.keepaliveService.stopWorkers(accountName);
    }

    // 立即登记并预设挂机 Session，优先使用缓存，若无缓存或已过期则先异步静默请求任务中心
    let cachedEntry = this.todayPointsCache.get(accountName);
    const todayStr = getCstDateString();
    if (!cachedEntry || !cachedEntry.summary || cachedEntry.date !== todayStr) {
      try {
        const sum = await this.getPointsAndTasks(accountName);
        cachedEntry = { todayPoints: sum.generalPoints + sum.phonePoints, date: todayStr, summary: sum, updatedAt: Date.now() };
      } catch {}
    }
    const hangTask = cachedEntry?.summary?.tasks?.find((t: any) => t.type === 'hang' || isHangTaskName(t.name, t.totalProgress));
    this.taskStrategyService.initPendingHangSession(accountName, hangTask?.currentProgress || 0, hangTask?.totalProgress || 3600);

    // 将桌面状态置为 hanging 并更新挂机状态，保证主页保活在线数不失联
    const state = this.accountStates.get(accountName);
    if (state) {
      for (const d of state.desktops) {
        (d as any).status = 'hanging';
      }
      state.hangStatus = this.taskStrategyService.getHangInfo(accountName) || undefined;
      this.notifyStatusChange();
    }

    // 后台异步触发智能补足挂机 (内置网络波动自愈与智能重试机制：最多尝试 5 次)
    (async () => {
      let hangResult: { success: boolean; message: string; isCompleted?: boolean } | null = null;
      const MAX_ATTEMPTS = 5;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          if (attempt > 1) {
            this.logger.addLog('info', `[${accountName}] 挂机会话异常或未达标，等待 5 秒进行第 ${attempt}/${MAX_ATTEMPTS} 次断线续挂...`);
            await new Promise((r) => setTimeout(r, 5000));
            // 重试前刷新一次实例凭据
            try {
              await client.getDesktopList();
            } catch {}
          }

          hangResult = await this.taskStrategyService.executeHang(accountName, client, (cur, tot) => {
            const curState = this.accountStates.get(accountName);
            // 只要达到目标秒数，毫秒级就地清理 hangStatus 并广播，绝不在界面留存 3600/3600 滞留卡片
            if (cur >= tot && curState?.hangStatus) {
              curState.hangStatus = undefined;
            }
            this.notifyStatusChange();
          });

          // 如果官方核验达标，则退出重试循环
          if (hangResult.isCompleted || (hangResult.success && !hangResult.message?.includes('补挂'))) {
            break;
          }

          // 如果是明确已被手动终止，不再重试
          if (hangResult.message?.includes('主动终止') || hangResult.message?.includes('已达成')) {
            break;
          }

          this.logger.addLog('warn', `[${accountName}] 第 ${attempt} 次挂机未达成: ${hangResult.message}`);
        } catch (e: any) {
          this.logger.addLog('warn', `[${accountName}] 第 ${attempt} 次挂机异常: ${e.message}`);
          hangResult = { success: false, message: e.message };
        }
      }

      // 挂机完成（或异常退出）后：若账号开启了保活(autoStart)，恢复底层 7x24 小时持久保活长连接 (挂机与保活解耦)
      try {
        const state = this.accountStates.get(accountName);
        if (state) {
          state.hangStatus = undefined;
          for (const d of state.desktops) {
            if ((d as any).status === 'hanging') {
              (d as any).status = 'connected';
            }
          }
        }
        const isKeepAliveEnabled = acc.autoStart !== false;
        if (isKeepAliveEnabled) {
          // 优先通过 resumeWorkers 恢复连接，若无对应 Worker 则走同步初始化
          const resumed = this.keepaliveService.resumeWorkers(accountName);
          if (!resumed) {
            try {
              const list = await client.getDesktopList();
              const desktopStates = state?.desktops || [];
              await this.keepaliveService.syncWorkersForAccount(accountName, client, list, desktopStates);
            } catch {}
          }
        } else {
          // 若关闭了保活，确保云电脑状态置为 stopped，不维持常驻 Worker
          if (state) {
            for (const d of state.desktops) {
              d.status = 'stopped';
            }
          }
        }

        // 挂机完成后自动拉取官方最新积分并刷新今日积分看板缓存
        let finalPoints = 0;
        try {
          const sum = await this.getPointsAndTasks(accountName);
          finalPoints = sum.generalPoints + sum.phonePoints;
        } catch {}

        // Webhook 推送挂机结果通知
        if (this.webhookUrl && hangResult) {
          const title = hangResult.success
            ? (hangResult.isCompleted
                ? `天翼云电脑 - [${accountName}] 智能挂机已达标`
                : `天翼云电脑 - [${accountName}] 智能挂机完成`)
            : `天翼云电脑 - [${accountName}] 智能挂机异常`;
          const content = `账号: ${accountName}\n挂机结果: ${hangResult.message}\n最新总积分: ${finalPoints || '已刷新'}\n完成时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
          sendWebhookNotification(this.webhookUrl, title, content).catch(() => {});
        }

        this.notifyStatusChange();
      } catch (err: any) {
        this.logger.addLog('warn', `[${accountName}] 挂机收尾处理提示: ${err.message}`);
      }
    })();

    return '已在后台启动智能挂机，正在动态核验并补足挂机时长';
  }

  public async stopHang(accountName: string): Promise<void> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client) throw new Error(`未找到账号: ${accountName}`);

    await this.taskStrategyService.stopHang(accountName);
    this.logger.addLog('info', `[${accountName}] 用户已手动中止挂机任务，正在恢复正常保活...`);

    const state = this.accountStates.get(accountName);
    if (state) {
      state.hangStatus = undefined;
      for (const d of state.desktops) {
        if ((d as any).status === 'hanging') {
          (d as any).status = 'connected';
        }
      }
    }

    try {
      const isKeepAliveEnabled = acc.autoStart !== false;
      if (isKeepAliveEnabled) {
        const resumed = this.keepaliveService.resumeWorkers(accountName);
        if (!resumed) {
          const list = await client.getDesktopList();
          const desktopStates = state?.desktops || [];
          await this.keepaliveService.syncWorkersForAccount(accountName, client, list, desktopStates);
        }
      }
    } catch {}

    this.notifyStatusChange();
  }

  public async manualSignIn(accountName: string): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法签到');
    }
    const res = await this.taskStrategyService.executeSign(client);
    const today = getCstDateString();
    acc.lastSignDate = today;
    const state = this.accountStates.get(accountName);
    if (state) state.lastSignDate = today;
    this.saveToDisk();
    this.logger.addLog('success', `[${accountName}] 签到完成: ${res.message}`);
    return res.message;
  }

  public async manualActivateDesktop(accountName: string): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法激活');
    }
    const state = this.accountStates.get(accountName);
    const dId = state?.desktops?.[0]?.desktopId;
    const res = await this.taskStrategyService.activateDesktopSession(client, dId, this.logger);
    this.logger.addLog('success', `[${accountName}] 登录云电脑: ${res.message}`);
    // 同步唤醒保活长连接以维持活跃，加速官方任务核验与积分结算
    this.reloadDesktops(accountName).catch(() => {});
    setTimeout(() => {
      this.getPointsAndTasks(accountName)
        .then(() => this.notifyStatusChange())
        .catch(() => {});
    }, 3000);
    return `${res.message}（官方系统在连接维持 1~2 分钟内自动核验发放积分）`;
  }

  public async manualAiChat(accountName: string): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法执行AI对话');
    }
    const res = await this.taskStrategyService.executeAiChat(client);
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

    const rConf: any = acc.redeemConfig || {};
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
      } catch (err: any) {
        this.logger.addLog('warn', `获取在线积分商品列表失败，回退使用本地缓存: ${err.message}`);
      }
    }
    // 若没有缓存则返回本地预设
    return this.rewardsCache && this.rewardsCache.length > 0 ? this.rewardsCache : DEFAULT_LOCAL_REWARDS;
  }

  public async getPointsAndTasks(accountName: string): Promise<PointsSummary> {
    const client = this.getClient(accountName);
    const summary = await this.taskStrategyService.getPointsAndTasks(client);
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

    // 智能同步日常任务完成状态：若官方显示所有日常任务均已达成，同步标记 lastRunDate 防止调度器误判补跑
    const acc = this.accounts.get(accountName);
    if (acc && acc.taskConfig) {
      const chatTask = summary.tasks.find((t) => t.type === 'chat');
      const loginTask = summary.tasks.find((t) => t.type === 'login');
      const hangTask = summary.tasks.find((t) => t.type === 'hang' || isHangTaskName(t.name, t.totalProgress));

      const isChatDone = !chatTask || chatTask.isCompleted || (chatTask.totalProgress > 0 && chatTask.currentProgress >= chatTask.totalProgress);
      const isLoginDone = !loginTask || loginTask.isCompleted || (loginTask.totalProgress > 0 && loginTask.currentProgress >= loginTask.totalProgress);
      const isHangDone = !hangTask || hangTask.isCompleted || (hangTask.totalProgress > 0 && hangTask.currentProgress >= hangTask.totalProgress);

      if (isChatDone && isLoginDone && isHangDone && acc.taskConfig.lastRunDate !== todayStr) {
        acc.taskConfig.lastRunDate = todayStr;
        acc.lastSignDate = todayStr;
        this.saveToDisk();
      }
    }

    return summary;
  }

  public saveToDisk(): void {
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

    // 2. 保存 accounts.json (账号与各账号独立策略配置)
    const list: AccountConfig[] = Array.from(this.accounts.values());
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
      let rawAccounts: any[] = [];
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
      const user = acc.loginInfo?.mobilephone || acc.user;
      let name = acc.name || user;
      // 如果此前自动生成的默认名称形如 '用户0130824707'，自动纠偏为手机号码
      if ((name === acc.user || /^用户\d+$/.test(name)) && acc.loginInfo?.mobilephone) {
        name = acc.loginInfo.mobilephone;
      }
      const deviceCode = Config.resolveDeviceCode(name, acc.deviceCode);
      const taskConfig = acc.taskConfig || {
        enabled: true,
        autoSign: true,
        loginDesktop: true,
        aiChat: true,
        keepAliveHang: true,
        scheduleTime: getRandomScheduleTime(),
      };
      if (!taskConfig.scheduleTime) {
        taskConfig.scheduleTime = getRandomScheduleTime();
      }
      const redeemConfig = acc.redeemConfig || { ...DEFAULT_REDEEM_CONFIG };
      const id = acc.id || crypto.randomUUID();
      const desktops = Array.isArray(acc.desktops) ? acc.desktops : [];
      const fullAcc: AccountConfig = { ...acc, id, name, user, deviceCode, taskConfig, redeemConfig, desktops };
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
        desktops: desktops.map((d: any) => ({
          desktopId: d.desktopId,
          desktopName: d.desktopName,
          desktopCode: d.desktopCode,
          useStatusText: d.useStatusText || '空闲',
          imageName: d.imageName || '',
          flavorName: d.flavorName || d.desktopName || '',
          status: 'idle',
          lastHeartbeat: d.lastHeartbeat,
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
    } catch (err: any) {
      this.logger.addLog('error', `加载配置文件 config.json 失败: ${err.message}`);
    }
  }
}
