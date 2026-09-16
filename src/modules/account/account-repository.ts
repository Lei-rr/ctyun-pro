import fs from 'node:fs';
import crypto from 'node:crypto';
import { Config, DEFAULT_REDEEM_CONFIG, getRandomScheduleTime, type AccountConfig, type TaskConfig, type RedeemConfig } from '../../config.js';
import { safeWriteFileSync } from '../../core/utils.js';
import { sortRewards, type RewardItem, DEFAULT_LOCAL_REWARDS } from '../reward/index.js';

const SAVE_CONFIG_DEBOUNCE_MS = 150;

export interface SystemConfigData {
  adminPassword: string;
  keepAliveSeconds: number;
  webhookUrl: string;
}

export class AccountRepository {
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  public loadConfig(): {
    system: SystemConfigData;
    rewards: RewardItem[];
    accounts: Map<string, AccountConfig>;
  } {
    Config.initDirs();

    // 1. 系统设置
    let adminPassword = '';
    let keepAliveSeconds = 60;
    let webhookUrl = '';

    if (fs.existsSync(Config.configFile)) {
      try {
        const sysContent = fs.readFileSync(Config.configFile, 'utf8');
        const sysJson = JSON.parse(sysContent);
        const sys = sysJson.system || sysJson;
        if (sys.adminPassword !== undefined) adminPassword = String(sys.adminPassword);
        if (sys.keepAliveSeconds) keepAliveSeconds = Number(sys.keepAliveSeconds);
        if (sys.webhookUrl !== undefined) webhookUrl = String(sys.webhookUrl);
      } catch {}
    }

    if (process.env.ADMIN_PASSWORD && !adminPassword) {
      adminPassword = process.env.ADMIN_PASSWORD;
    }

    // 2. 奖励目录
    let rewards: RewardItem[] = [];
    if (fs.existsSync(Config.rewardsFile)) {
      try {
        const rewContent = fs.readFileSync(Config.rewardsFile, 'utf8');
        const rewJson = JSON.parse(rewContent);
        if (Array.isArray(rewJson) && rewJson.length > 0) {
          rewards = sortRewards(rewJson);
        }
      } catch {}
    }

    if (rewards.length === 0) {
      try {
        rewards = sortRewards([...DEFAULT_LOCAL_REWARDS]);
        safeWriteFileSync(Config.rewardsFile, JSON.stringify(rewards, null, 2));
      } catch {}
    }

    // 3. 账号列表
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
        if (legacyCfg.system?.rewardsCache && (!rewards || rewards.length === 0)) {
          rewards = legacyCfg.system.rewardsCache;
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
      accounts.set(name, fullAcc);
    }

    return {
      system: { adminPassword, keepAliveSeconds, webhookUrl },
      rewards,
      accounts,
    };
  }

  public saveToDisk(
    system: SystemConfigData,
    accounts: Map<string, AccountConfig>,
    rewards: RewardItem[],
    immediate = false,
  ): void {
    if (immediate) {
      if (this.saveDebounceTimer) {
        clearTimeout(this.saveDebounceTimer);
        this.saveDebounceTimer = null;
      }
      this.executeSave(system, accounts, rewards);
      return;
    }

    if (this.saveDebounceTimer) return;
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.executeSave(system, accounts, rewards);
    }, SAVE_CONFIG_DEBOUNCE_MS);
  }

  private executeSave(
    system: SystemConfigData,
    accounts: Map<string, AccountConfig>,
    rewards: RewardItem[],
  ): void {
    Config.initDirs();

    // 1. config.json
    const sysData = {
      system: {
        adminPassword: system.adminPassword,
        keepAliveSeconds: system.keepAliveSeconds,
        webhookUrl: system.webhookUrl,
      },
    };
    safeWriteFileSync(Config.configFile, JSON.stringify(sysData, null, 2));

    // 2. accounts.json (脱敏安全落盘)
    const list: AccountConfig[] = Array.from(accounts.values()).map((acc) => {
      const sanitized = { ...acc };
      delete sanitized.password;
      delete sanitized.rawPassword;
      return sanitized;
    });
    safeWriteFileSync(Config.accountsFile, JSON.stringify(list, null, 2));

    // 3. rewards.json
    if (rewards && rewards.length > 0) {
      safeWriteFileSync(Config.rewardsFile, JSON.stringify(rewards, null, 2));
    }
  }

  public exportConfigSafe(
    system: SystemConfigData,
    accounts: Map<string, AccountConfig>,
  ) {
    return {
      version: '3.0.0',
      exportedAt: new Date().toISOString(),
      system: {
        keepAliveSeconds: system.keepAliveSeconds,
        webhookUrl: system.webhookUrl,
      },
      accounts: Array.from(accounts.values()).map((acc) => {
        const sanitized = { ...acc };
        delete sanitized.password;
        delete sanitized.rawPassword;
        return sanitized;
      }),
    };
  }

  public importConfigSafe(
    data: unknown,
    currentSystem: SystemConfigData,
    targetAccounts: Map<string, AccountConfig>,
  ): { importedAccounts: number; updatedSystem: Partial<SystemConfigData> } {
    if (!data || typeof data !== 'object') {
      throw new Error('导入的配置文件格式非法');
    }
    const cfg = data as Record<string, unknown>;
    const updatedSystem: Partial<SystemConfigData> = {};

    if (cfg.system && typeof cfg.system === 'object') {
      const sys = cfg.system as Record<string, unknown>;
      if (typeof sys.keepAliveSeconds === 'number' && sys.keepAliveSeconds >= 10) {
        updatedSystem.keepAliveSeconds = sys.keepAliveSeconds;
      }
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
