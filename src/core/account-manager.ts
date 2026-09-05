import fs from 'node:fs';
import { Config, getRandomScheduleTime, type AccountConfig, type TaskConfig, type RedeemConfig } from '../config.js';
import { CtYunClient, type Desktop, type DesktopInfo, type LoginInfo } from './client.js';
import { KeepAliveManager, type ManagedDesktopState } from '../keepalive/keepalive-manager.js';
import { Logger, type LogItem } from './logger.js';
import { TaskScheduler } from '../tasks/scheduler.js';
import { TaskRunner } from '../tasks/task-runner.js';
import { SignTask, type PointsSummary } from '../tasks/sign.js';
import { RedeemTask, DEFAULT_LOCAL_REWARDS, sortRewards, type RewardItem } from '../tasks/redeem.js';
import { AiChatTask } from '../tasks/ai-chat.js';
import { HangTask } from '../tasks/hang.js';
import { safeWriteFileSync } from './utils.js';

export interface ManagedAccount {
  name: string;
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
 * 协调：账号认证存储、保活管理器 (KeepAliveManager)、定时调度器 (TaskScheduler)
 */
export class AccountManager {
  private accounts: Map<string, AccountConfig> = new Map();
  private clients: Map<string, CtYunClient> = new Map();
  private accountStates: Map<string, ManagedAccount> = new Map();
  private logger: Logger = new Logger();
  private keepAliveManager: KeepAliveManager;
  private taskScheduler: TaskScheduler;
  private statusListeners: Set<() => void> = new Set();

  public keepAliveSeconds = 60;
  public adminPassword = '';
  public webhookUrl = '';
  public rewardsCache: RewardItem[] = [...DEFAULT_LOCAL_REWARDS];
  private todayPointsCache: Map<string, { todayPoints: number; updatedAt: number }> = new Map();

  constructor() {
    this.keepAliveManager = new KeepAliveManager(this.logger, () => this.notifyStatusChange());
    this.taskScheduler = new TaskScheduler(this, this.logger);
    this.loadFromDisk();
    this.taskScheduler.start();
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

  public getAccount(nameOrUser: string): AccountConfig | undefined {
    let acc = this.accounts.get(nameOrUser);
    if (!acc) {
      for (const a of this.accounts.values()) {
        if (a.user === nameOrUser || a.name === nameOrUser) {
          acc = a;
          break;
        }
      }
    }
    return acc;
  }

  public getAccountState(nameOrUser: string): ManagedAccount | undefined {
    let state = this.accountStates.get(nameOrUser);
    if (!state) {
      for (const s of this.accountStates.values()) {
        if (s.user === nameOrUser || s.name === nameOrUser) {
          state = s;
          break;
        }
      }
    }
    return state;
  }

  public getClient(nameOrUser: string): CtYunClient {
    const acc = this.getAccount(nameOrUser);
    const key = acc?.name || nameOrUser;
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
        state.autoSign = acc.autoSign ?? false;
        state.lastSignDate = acc.lastSignDate;
        state.taskConfig = acc.taskConfig || {
          enabled: acc.autoSign ?? true,
          autoSign: true,
          loginDesktop: true,
          aiChat: true,
        };
        state.redeemConfig = acc.redeemConfig;
        state.hangStatus = HangTask.getHangInfo(name) || undefined;
        state.todayPoints = this.todayPointsCache.get(name)?.todayPoints ?? 0;
      }
    }
    return Array.from(this.accountStates.values());
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
    this.keepAliveManager.stopWorkers(accountName);
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
    this.keepAliveManager.stopAll();
    await HangTask.destroy();
    this.saveToDisk();
  }

  public async operateDesktop(
    accountName: string,
    desktopId: string,
    operation: 'on' | 'shutdown' | 'reset',
  ): Promise<string> {
    const state = this.accountStates.get(accountName);
    const client = this.getClient(accountName);
    const desktop = state?.desktops.find((item) => item.desktopId === desktopId);
    if (!state || !desktop || !client.loginInfo) throw new Error('未找到可操作的云电脑或账号未登录');

    if (operation === 'shutdown' || operation === 'reset') {
      this.keepAliveManager.stopWorkers(accountName);
      desktop.status = 'stopped';
      desktop.lastHeartbeat = undefined;
      desktop.useStatusText = operation === 'shutdown' ? '已关机' : '重启中';
      this.notifyStatusChange();
    } else {
      desktop.status = 'connecting';
      desktop.useStatusText = '启动中';
      this.notifyStatusChange();
    }

    try {
      const targetObjType = desktop.objType ?? 0;
      const message = await client.operateDesktop(desktopId, operation, targetObjType);
      this.logger.addLog('info', `[${accountName}][${desktopId}] ${message}`);
      // 后台轮询跟踪云电脑电源状态，直至真正开机或关机完成
      this.trackDesktopStatusAfterPower(accountName, desktopId, operation);
      return message;
    } catch (error) {
      desktop.status = 'stopped';
      desktop.useStatusText = '操作失败';
      this.notifyStatusChange();
      throw error;
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
    const client = this.getClient(accountName);
    let attempts = 0;
    const maxAttempts = 60; // 最多轮询 5 分钟 (每 5 秒一次)

    const timer = setInterval(async () => {
      attempts++;
      try {
        const list = await client.getDesktopList();
        const current = list.find((d) => String(d.desktopId) === String(desktopId));
        const state = this.accountStates.get(accountName);
        const target = state?.desktops.find((d) => String(d.desktopId) === String(desktopId));

        if (current && target) {
          target.useStatusText = current.useStatusText;

          if (operation === 'on' || operation === 'reset') {
            if (current.useStatusText === '运行中') {
              clearInterval(timer);
              target.status = 'connecting';
              this.logger.addLog('success', `[${accountName}][${desktopId}] 云电脑已成功开机，正在接入保活...`);
              this.notifyStatusChange();
              // 云电脑开机成功后，若账号处于保活状态，自动启动该桌面的 WebSocket 保活
              this.reloadDesktops(accountName).catch(() => {});
              return;
            }
          } else if (operation === 'shutdown') {
            if (current.useStatusText === '已关机' || current.useStatusText === '关机') {
              clearInterval(timer);
              target.status = 'stopped';
              this.logger.addLog('info', `[${accountName}][${desktopId}] 云电脑已安全关机`);
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

    this.keepAliveManager.stopWorkers(oldName);
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

    this.saveToDisk();
    this.notifyStatusChange();
    this.logger.addLog('info', `[${oldName}] 备注名称已修改为 [${trimmed}]`);

    if (acc.loginInfo) {
      this.reloadDesktops(trimmed).catch(() => {});
    }
  }

  public async reloadDesktops(accountName: string): Promise<void> {
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
      return;
    }

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

    // 检查是否开启了保活长连接 (由 autoStart 控制，且若配置了 keepAliveHang 开关则遵从)
    const isKeepAliveEnabled = acc.autoStart !== false && (acc.taskConfig?.keepAliveHang ?? true);
    if (!isKeepAliveEnabled) {
      this.keepAliveManager.stopWorkers(accountName);
      for (const d of state.desktops) {
        d.status = 'stopped';
      }
      return;
    }

    await this.keepAliveManager.syncWorkersForAccount(accountName, client, list, state.desktops);
  }

  public async addOrUpdateAccount(config: AccountConfig): Promise<void> {
    const name = config.name || config.user;
    const deviceCode = config.deviceCode || Config.resolveDeviceCode(name);
    const fullAcc: AccountConfig = { ...config, name, deviceCode };

    this.accounts.set(name, fullAcc);
    let state = this.accountStates.get(name);
    if (!state) {
      state = {
        name,
        user: config.user,
        deviceCode,
        status: config.loginInfo ? 'online' : 'login_needed',
        loginInfo: config.loginInfo,
        autoSign: config.autoSign ?? true,
        lastSignDate: config.lastSignDate,
        taskConfig: config.taskConfig || {
          enabled: true,
          autoSign: true,
          loginDesktop: true,
          aiChat: true,
          scheduleTime: getRandomScheduleTime(),
        },
        redeemConfig: config.redeemConfig,
        desktops: [],
      };
      this.accountStates.set(name, state);
    } else {
      state.user = config.user;
      state.deviceCode = deviceCode;
      state.autoSign = config.autoSign ?? state.autoSign;
      state.lastSignDate = config.lastSignDate ?? state.lastSignDate;
      state.taskConfig = config.taskConfig ?? state.taskConfig;
      state.redeemConfig = config.redeemConfig ?? state.redeemConfig;
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
      await this.reloadDesktops(name);
    }
  }

  public removeAccount(name: string): void {
    this.keepAliveManager.stopWorkers(name);
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
    const res = await TaskRunner.executeDailyTasks(client, dId, acc.taskConfig);
    const today = new Date().toISOString().split('T')[0];
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

    if (HangTask.isRunning(accountName)) {
      return '后台挂机任务已在运行中，无需重复触发';
    }

    // 挂机启动前：临时暂停底层保活连接，防止与网页端互相踢线争抢 session
    this.keepAliveManager.stopWorkers(accountName);

    // 将桌面状态置为 hanging 并更新挂机状态，保证主页保活在线数不失联
    const state = this.accountStates.get(accountName);
    if (state) {
      for (const d of state.desktops) {
        (d as any).status = 'hanging';
      }
      this.notifyStatusChange();
    }

    // 后台异步触发智能补足挂机
    (async () => {
      try {
        await HangTask.executeSmartHang(accountName, client, this.logger, () => {
          this.notifyStatusChange();
        });
      } catch (e: any) {
        this.logger.addLog('warn', `[${accountName}] 智能挂机提示: ${e.message}`);
      } finally {
        // 挂机完成（或异常退出）后：恢复底层 7x24 小时持久保活长连接
        try {
          const list = await client.getDesktopList();
          const state = this.accountStates.get(accountName);
          const desktopStates = state?.desktops || [];
          await this.keepAliveManager.syncWorkersForAccount(accountName, client, list, desktopStates);
        } catch {}
        this.notifyStatusChange();
      }
    })();

    return '已在后台启动智能挂机，正在动态核验并补足挂机时长';
  }

  public async manualSignIn(accountName: string): Promise<string> {
    const acc = this.accounts.get(accountName);
    const client = this.getClient(accountName);
    if (!acc || !client.loginInfo) {
      throw new Error('账号未登录，无法签到');
    }
    const res = await SignTask.signIn(client);
    const today = new Date().toISOString().split('T')[0];
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
    const res = await TaskRunner.activateDesktopSession(client, dId);
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

    const rConf: any = acc.redeemConfig || {};
    const targetDesktopId = desktopId || rConf.targetDesktopId || this.accountStates.get(accountName)?.desktops?.[0]?.desktopId;
    if (!targetDesktopId) {
      throw new Error('名下未找到云电脑实例，无法兑换');
    }

    const res = await RedeemTask.placeOrder(
      client,
      targetDesktopId,
      prodId || rConf.targetProdId,
      costPoints || rConf.costPoints,
      prodType || rConf.prodType,
    );

    const today = new Date().toISOString().split('T')[0];
    rConf.lastRedeemDate = today;
    acc.redeemConfig = rConf;
    this.saveToDisk();
    this.logger.addLog('success', `[${accountName}] ${res.message}`);
    return res.message;
  }

  public async getAvailableRewards(accountName?: string, forceRefresh = false): Promise<RewardItem[]> {
    // 默认直接返回本地已加载/缓存的商品目录（毫秒级、顺序稳定一致）
    // 只有在用户主动点击“刷新”按钮（forceRefresh = true）时，才请求官方接口同步最新商品
    if (forceRefresh && accountName) {
      try {
        const client = this.getClient(accountName);
        const items = await RedeemTask.getAvailableRewards(client);
        if (items && items.length > 0) {
          this.rewardsCache = items;
          this.saveToDisk();
          return items;
        }
      } catch (e: any) {
        this.logger.addLog('warn', `[${accountName}] 强制拉取官方商品失败: ${e.message}，保持现有本地商品`);
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
    this.todayPointsCache.set(accountName, { todayPoints: todayEarned, updatedAt: Date.now() });
    const state = this.accountStates.get(accountName);
    if (state) {
      state.todayPoints = todayEarned;
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
      const name = acc.name || acc.user;
      const deviceCode = Config.resolveDeviceCode(name, acc.deviceCode);
      const fullAcc: AccountConfig = { ...acc, name, deviceCode };
      this.accounts.set(name, fullAcc);

      const client = this.getClient(name);
      if (acc.loginInfo) {
        client.loginInfo = acc.loginInfo;
      }

      const state: ManagedAccount = {
        name,
        user: acc.user,
        deviceCode: acc.deviceCode || client.getDeviceCode(),
        status: acc.loginInfo ? 'online' : 'login_needed',
        loginInfo: acc.loginInfo,
        autoSign: acc.autoSign ?? true,
        lastSignDate: acc.lastSignDate,
        taskConfig: acc.taskConfig || {
          enabled: true,
          autoSign: true,
          loginDesktop: true,
          aiChat: true,
          scheduleTime: '08:00',
        },
        redeemConfig: acc.redeemConfig,
        desktops: [],
      };
      this.accountStates.set(name, state);
    }

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
