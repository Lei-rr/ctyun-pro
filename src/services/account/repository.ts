import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_VERSION, Config, DEFAULT_REDEEM_CONFIG, type AccountConfig } from '../../config.js';
import { safeWriteFileSync } from '../../infra/fs.js';

const SAVE_CONFIG_DEBOUNCE_MS = 150;

export interface SystemConfigData {
  adminPassword: string;
  webhookUrl: string;
}

export class AccountRepository {
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  /** 防抖期间仅保留最新一次待写数据，避免闭包持有旧快照导致丢写 */
  private pendingSave: { system: SystemConfigData; accounts: Map<string, AccountConfig> } | null = null;

  public loadConfig(): {
    system: SystemConfigData;
    accounts: Map<string, AccountConfig>;
  } {
    Config.initDirs();

    // 清理历史遗留的商品目录持久化文件 (现已改为纯内存缓存，不再落盘)
    try {
      const legacyRewardsFile = path.join(Config.dataDir, 'rewards.json');
      if (fs.existsSync(legacyRewardsFile)) fs.unlinkSync(legacyRewardsFile);
    } catch {}

    // 1. 系统设置
    let adminPassword = '';
    let webhookUrl = '';

    if (fs.existsSync(Config.configFile)) {
      try {
        const sysContent = fs.readFileSync(Config.configFile, 'utf8');
        const sysJson = JSON.parse(sysContent);
        const sys = sysJson.system || sysJson;
        if (sys.adminPassword !== undefined) adminPassword = String(sys.adminPassword);
        if (sys.webhookUrl !== undefined) webhookUrl = String(sys.webhookUrl);
      } catch {}
    }

    if (process.env.ADMIN_PASSWORD && !adminPassword) {
      adminPassword = process.env.ADMIN_PASSWORD;
    }

    // 2. 账号列表
    const accounts = new Map<string, AccountConfig>();
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

    // 兼容旧版 config.json 内含 accounts 字段
    if (rawAccounts.length === 0 && fs.existsSync(Config.configFile)) {
      try {
        const legacyCfg = JSON.parse(fs.readFileSync(Config.configFile, 'utf8'));
        if (Array.isArray(legacyCfg.accounts)) {
          rawAccounts = legacyCfg.accounts;
        }
      } catch {}
    }

    for (const acc of rawAccounts) {
      const user = String(acc.loginInfo?.mobilephone || acc.user || '').trim();
      if (!user) continue;
      let name = String(acc.name || user).trim();
      if ((name === acc.user || /^用户\d+$/.test(name)) && acc.loginInfo?.mobilephone) {
        name = acc.loginInfo.mobilephone;
      }
      const deviceCode = Config.resolveDeviceCode(name, acc.deviceCode);
      const taskConfig = acc.taskConfig || {
        enabled: true,
        aiChat: true,
      };
      const redeemConfig = acc.redeemConfig || { ...DEFAULT_REDEEM_CONFIG };
      const id = acc.id || crypto.randomUUID();
      const desktops = Array.isArray(acc.desktops) ? acc.desktops : [];
      const fullAcc: AccountConfig = { ...acc, id, name, user, deviceCode, taskConfig, redeemConfig, desktops };
      delete fullAcc.password;
      delete fullAcc.rawPassword;
      accounts.set(name, fullAcc);
    }

    return {
      system: { adminPassword, webhookUrl },
      accounts,
    };
  }

  public saveToDisk(
    system: SystemConfigData,
    accounts: Map<string, AccountConfig>,
    immediate = false,
  ): void {
    if (immediate) {
      if (this.saveDebounceTimer) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
      }
      this.pendingSave = null;
      this.executeSave(system, accounts);
      return;
    }

    this.pendingSave = { system, accounts };
    if (this.saveDebounceTimer) return;
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      const pending = this.pendingSave;
      this.pendingSave = null;
      if (pending) this.executeSave(pending.system, pending.accounts);
    }, SAVE_CONFIG_DEBOUNCE_MS);
  }

  private executeSave(
    system: SystemConfigData,
    accounts: Map<string, AccountConfig>,
  ): void {
    Config.initDirs();

    // 1. config.json
    const sysData = {
      system: {
        adminPassword: system.adminPassword,
        webhookUrl: system.webhookUrl,
      },
    };
    safeWriteFileSync(Config.configFile, JSON.stringify(sysData, null, 2));

    // 2. accounts.json (脱敏安全落盘，彻底移除 scheduleTime 本地存储)
    const list: AccountConfig[] = Array.from(accounts.values()).map((acc) => {
      const sanitized = { ...acc };
      delete sanitized.password;
      delete sanitized.rawPassword;
      if (sanitized.taskConfig) {
        sanitized.taskConfig = { ...sanitized.taskConfig };
        delete (sanitized.taskConfig as unknown as Record<string, unknown>).scheduleTime;
      }
      return sanitized;
    });
    safeWriteFileSync(Config.accountsFile, JSON.stringify(list, null, 2));
  }

  public exportConfigSafe(
    system: SystemConfigData,
    accounts: Map<string, AccountConfig>,
  ) {
    return {
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      system: {
        webhookUrl: system.webhookUrl,
      },
      accounts: Array.from(accounts.values()).map((acc) => {
        const sanitized = { ...acc };
        delete sanitized.password;
        delete sanitized.rawPassword;
        if (sanitized.taskConfig) {
          sanitized.taskConfig = { ...sanitized.taskConfig };
          delete (sanitized.taskConfig as unknown as Record<string, unknown>).scheduleTime;
        }
        return sanitized;
      }),
    };
  }

  public importConfigSafe(
    data: unknown,
    targetAccounts: Map<string, AccountConfig>,
  ): { importedAccounts: number; updatedSystem: Partial<SystemConfigData> } {
    if (!data || typeof data !== 'object') {
      throw new Error('导入的配置文件格式非法');
    }
    const cfg = data as Record<string, unknown>;
    const updatedSystem: Partial<SystemConfigData> = {};

    if (cfg.system && typeof cfg.system === 'object') {
      const sys = cfg.system as Record<string, unknown>;
      if (typeof sys.webhookUrl === 'string') {
        updatedSystem.webhookUrl = sys.webhookUrl.trim();
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
        targetAccounts.set(sanitized.name, sanitized);
        importedAccounts++;
      }
    }

    return { importedAccounts, updatedSystem };
  }
}
