import fs from 'node:fs';
import { Config, type AccountConfig, type AppConfigFile } from '../config.js';
import { CtYunClient, type Desktop, type LoginInfo } from './client.js';
import { Logger, type LogItem } from './logger.js';
import { KeepAliveManager, type ManagedDesktopState } from '../keepalive/keepalive-manager.js';
import { TaskRunner } from '../tasks/task-runner.js';
import { SignTask, type PointsSummary } from '../tasks/sign.js';
import { RedeemTask, type RewardItem } from '../tasks/redeem.js';
import { TaskScheduler } from '../tasks/scheduler.js';

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

    await this.reloadDesktops(accountName);
    state.status = 'online';
    this.notifyStatusChange();
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
      const message = await client.operateDesktop(desktopId, operation);
      this.logger.addLog('info', `[${accountName}][${desktopId}] ${message}`);
      return message;
    } catch (error) {
      desktop.status = 'stopped';
      desktop.useStatusText = '操作失败';
      this.notifyStatusChange();
      throw error;
    }
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

    // Login starts the unified protocol session used for keepalive and task timing.
    const isKeepAliveEnabled = acc.autoStart !== false;
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
          scheduleTime: '08:00',
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
      acc.taskConfig = { enabled: true, autoSign: true, scheduleTime: '08:00' };
    }
    acc.taskConfig.lastRunDate = today;
    if (state) {
      state.lastSignDate = today;
      state.taskConfig = acc.taskConfig;
    }
    this.saveToDisk();
    this.logger.addLog('success', `[${accountName}] 每日任务已执行: ${res.message}`);
    this.notifyStatusChange();

    return res.message;
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
    this.logger.addLog('success', `[${accountName}] ${res.message}`);
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

  public async getAvailableRewards(accountName: string): Promise<RewardItem[]> {
    const client = this.getClient(accountName);
    return RedeemTask.getAvailableRewards(client);
  }

  public async getPointsAndTasks(accountName: string): Promise<PointsSummary> {
    const client = this.getClient(accountName);
    return SignTask.getPointsAndTasks(client);
  }

  public saveToDisk(): void {
    Config.initDirs();
    const list: AccountConfig[] = Array.from(this.accounts.values());
    const data: AppConfigFile = {
      system: {
        adminPassword: this.adminPassword,
        keepAliveSeconds: this.keepAliveSeconds,
        webhookUrl: this.webhookUrl,
      },
      accounts: list,
    };
    fs.writeFileSync(Config.configFile, JSON.stringify(data, null, 2), 'utf8');
  }

  public loadFromDisk(): void {
    Config.initDirs();
    const file = Config.accountsFile;
    if (!fs.existsSync(file)) {
      return;
    }

    try {
      const content = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(content) as any;

      if (data.system) {
        if (data.system.adminPassword !== undefined) this.adminPassword = data.system.adminPassword;
        if (data.system.keepAliveSeconds) this.keepAliveSeconds = data.system.keepAliveSeconds;
        if (data.system.webhookUrl !== undefined) this.webhookUrl = data.system.webhookUrl;
      } else {
        if (data.adminPassword !== undefined) this.adminPassword = data.adminPassword;
        if (data.keepAliveSeconds) this.keepAliveSeconds = data.keepAliveSeconds;
      }

      if (process.env.ADMIN_PASSWORD && !this.adminPassword) {
        this.adminPassword = process.env.ADMIN_PASSWORD;
      }

      if (Array.isArray(data.accounts)) {
        for (const acc of data.accounts) {
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
      }

      this.logger.addLog('info', `已加载本地配置文件 (${this.accounts.size} 个账号)`);

      for (const [name, acc] of this.accounts.entries()) {
        if (acc.loginInfo && acc.autoStart !== false) {
          this.reloadDesktops(name).catch((err) => {
            this.logger.addLog('warn', `[${name}] 自启动保活提示: ${err.message}`);
          });
        }
      }
    } catch (err: any) {
      this.logger.addLog('error', `加载配置文件 config.json 失败: ${err.message}`);
    }
  }
}
