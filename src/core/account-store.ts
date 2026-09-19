import crypto from 'node:crypto';
import { Config, DEFAULT_REDEEM_CONFIG, type AccountConfig } from '../config.js';
import { CtYunClient, type LoginInfo } from '../ctyun/client.js';
import { AccountRepository } from '../services/account/repository.js';
import { AccountSanitizer } from '../services/account/sanitizer.js';
import { DEFAULT_LOCAL_REWARDS, type RewardItem } from '../services/reward/service.js';
import type { PointsSummary } from '../services/tasks/points.js';
import type { ManagedAccount, ManagedDesktopState } from '../types.js';

export interface TodayPointsCacheEntry {
  todayPoints: number;
  date: string;
  summary?: PointsSummary;
  updatedAt: number;
}

/**
 * 账号数据层：账号配置、运行时状态、客户端实例与本地持久化
 * 不含保活/任务/探针等业务编排，供 ProfileManager 组合使用
 */
export class AccountStore {
  public readonly accounts = new Map<string, AccountConfig>();
  public readonly clients = new Map<string, CtYunClient>();
  public readonly states = new Map<string, ManagedAccount>();
  public readonly todayPointsCache = new Map<string, TodayPointsCacheEntry>();

  public adminPassword = '';
  public webhookUrl = '';
  public rewardsCache: RewardItem[] = [...DEFAULT_LOCAL_REWARDS];
  public rewardsCacheUpdatedAt = 0;

  private repository = new AccountRepository();

  public getAllAccounts(): Map<string, AccountConfig> {
    return this.accounts;
  }

  /** 按不可变 id → Map Key → user/name 三级寻址 */
  public getAccount(keyOrId: string): AccountConfig | undefined {
    if (!keyOrId) return undefined;
    for (const a of this.accounts.values()) {
      if (a.id === keyOrId) return a;
    }
    const direct = this.accounts.get(keyOrId);
    if (direct) return direct;
    for (const a of this.accounts.values()) {
      if (a.user === keyOrId || a.name === keyOrId) return a;
    }
    return undefined;
  }

  public hasAccount(name: string): boolean {
    return this.accounts.has(name);
  }

  public getClient(keyOrId: string): CtYunClient {
    const acc = this.getAccount(keyOrId);
    const key = acc?.name || keyOrId;
    let client = this.clients.get(key);
    if (!client) {
      const devCode = acc?.deviceCode || Config.resolveDeviceCode(key);
      client = new CtYunClient(devCode);
      if (acc?.loginInfo) client.loginInfo = acc.loginInfo;
      this.clients.set(key, client);
    }
    return client;
  }

  /** 原始状态引用 (内部业务使用，禁止直接对外返回) */
  public getState(keyOrId: string): ManagedAccount | undefined {
    if (!keyOrId) return undefined;
    for (const s of this.states.values()) {
      if (s.id === keyOrId) return s;
    }
    const direct = this.states.get(keyOrId);
    if (direct) return direct;
    for (const s of this.states.values()) {
      if (s.user === keyOrId || s.name === keyOrId) return s;
    }
    return undefined;
  }

  /** 对外脱敏只读快照 */
  public getAccountState(keyOrId: string): ManagedAccount | undefined {
    const state = this.getState(keyOrId);
    return state ? AccountSanitizer.sanitizeAccount(state) : undefined;
  }

  public sanitizeLoginInfo(info?: LoginInfo): LoginInfo | undefined {
    return AccountSanitizer.sanitizeLoginInfo(info);
  }

  public sanitizeAccount(accountOrState: ManagedAccount | AccountConfig): ManagedAccount;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined;
  public sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined {
    return AccountSanitizer.sanitizeAccount(accountOrState);
  }

  /**
   * 新增或更新账号 (纯内存变更，持久化与业务副作用由调用方负责)
   */
  public upsert(config: AccountConfig): { name: string; state: ManagedAccount; client: CtYunClient } {
    const user = config.loginInfo?.mobilephone || config.user;
    const name = config.name || user;
    const deviceCode = config.deviceCode || Config.resolveDeviceCode(name);
    const existingAcc = this.getAccount(config.id || name);
    const id = config.id || existingAcc?.id || crypto.randomUUID();
    const taskConfig = config.taskConfig || existingAcc?.taskConfig || { enabled: true, aiChat: true };
    const redeemConfig = config.redeemConfig || { ...DEFAULT_REDEEM_CONFIG };

    const fullAcc: AccountConfig = { ...config, id, name, user, deviceCode, taskConfig, redeemConfig };
    delete fullAcc.password;
    delete fullAcc.rawPassword;
    this.accounts.set(name, fullAcc);

    let state = this.states.get(name);
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
      this.states.set(name, state);
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
    if (config.loginInfo) client.loginInfo = config.loginInfo;
    return { name, state, client };
  }

  public remove(name: string): void {
    this.todayPointsCache.delete(name);
    this.accounts.delete(name);
    this.clients.delete(name);
    this.states.delete(name);
  }

  /** 重命名账号并迁移所有关联表，返回迁移后的实体供调用方处理缓存的定时器 */
  public rename(oldName: string, newName: string): { acc: AccountConfig; state?: ManagedAccount; client?: CtYunClient } {
    const acc = this.accounts.get(oldName);
    if (!acc) throw new Error('未找到该账号');

    const state = this.states.get(oldName);
    const client = this.clients.get(oldName);
    this.accounts.delete(oldName);
    this.states.delete(oldName);
    this.clients.delete(oldName);

    acc.name = newName;
    this.accounts.set(newName, acc);
    if (state) {
      state.name = newName;
      this.states.set(newName, state);
    }
    if (client) this.clients.set(newName, client);

    const pts = this.todayPointsCache.get(oldName);
    if (pts) {
      this.todayPointsCache.delete(oldName);
      this.todayPointsCache.set(newName, pts);
    }
    return { acc, state, client };
  }

  public setRewardsCache(items: RewardItem[]): void {
    this.rewardsCache = items;
    this.rewardsCacheUpdatedAt = Date.now();
  }

  public resetTodayPoints(dateStr: string): void {
    for (const [name, state] of this.states.entries()) {
      state.todayPoints = 0;
      const cached = this.todayPointsCache.get(name);
      if (cached) {
        cached.todayPoints = 0;
        cached.date = dateStr;
      }
    }
  }

  public exportConfigSafe() {
    return this.repository.exportConfigSafe(
      { adminPassword: this.adminPassword, webhookUrl: this.webhookUrl },
      this.accounts,
    );
  }

  public importConfigSafe(data: unknown): { importedAccounts: number; webhookUrl?: string } {
    const res = this.repository.importConfigSafe(data, this.accounts);
    if (res.updatedSystem.webhookUrl !== undefined) {
      this.webhookUrl = res.updatedSystem.webhookUrl;
    }
    return { importedAccounts: res.importedAccounts, webhookUrl: this.webhookUrl };
  }

  public saveToDisk(immediate = false): void {
    this.repository.saveToDisk(
      { adminPassword: this.adminPassword, webhookUrl: this.webhookUrl },
      this.accounts,
      immediate,
    );
  }

  /**
   * 从本地加载配置并重建状态与客户端，返回需要自启动 (autoStart !== false 且已登录) 的账号名
   */
  public loadFromDisk(): { autoStartAccountNames: string[] } {
    const data = this.repository.loadConfig();
    this.adminPassword = data.system.adminPassword || '';
    this.webhookUrl = data.system.webhookUrl || '';
    this.accounts.clear();
    this.states.clear();
    this.clients.clear();
    for (const [name, acc] of data.accounts.entries()) {
      this.accounts.set(name, acc);
    }
    this.rewardsCache = [...DEFAULT_LOCAL_REWARDS];
    this.rewardsCacheUpdatedAt = 0;

    const autoStartAccountNames: string[] = [];
    for (const [name, acc] of this.accounts.entries()) {
      const client = this.getClient(name);
      if (acc.loginInfo) client.loginInfo = acc.loginInfo;

      const desktops = Array.isArray(acc.desktops) ? acc.desktops : [];
      this.states.set(name, {
        id: acc.id || crypto.randomUUID(),
        name,
        user: acc.user,
        deviceCode: acc.deviceCode || client.getDeviceCode(),
        status: acc.loginInfo ? 'online' : 'login_needed',
        loginInfo: acc.loginInfo,
        taskConfig: acc.taskConfig,
        redeemConfig: acc.redeemConfig,
        desktops: desktops.map((d: ManagedDesktopState) => ({
          ...d,
          useStatusText: d.useStatusText || '空闲',
          imageName: d.imageName || '',
          flavorName: d.flavorName || d.desktopName || '',
          status: 'idle' as const,
          lastHeartbeat: typeof d.lastHeartbeat === 'string' ? d.lastHeartbeat : undefined,
        })),
      });
      if (acc.loginInfo && acc.autoStart !== false) autoStartAccountNames.push(name);
    }
    return { autoStartAccountNames };
  }
}
