import path from 'node:path';
import fs from 'node:fs';

export interface RedeemConfig {
  enabled: boolean;
  targetProdId?: number; // 官方商品 ID
  costPoints?: number; // 默认 500
  prodType?: string; // 官方商品类型
  targetDesktopId?: string; // 指定绑定的云电脑
  scheduleType: 'monthly_last_day' | 'monthly_day' | 'interval_days' | 'daily' | 'specific_date';
  monthlyDay?: number; // 每月几号 (如 28)
  intervalDays?: number; // 间隔几天
  specificDate?: string; // 指定固定日期兑换 (如 2026-09-30)
  lastRedeemDate?: string; // YYYY-MM-DD
}

export function getRandomScheduleTime(): string {
  const hour = Math.floor(Math.random() * 9); // 0 ~ 8 点之间随机
  const minute = Math.floor(Math.random() * 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
}

export interface TaskConfig {
  enabled: boolean; // 是否开启自动做任务
  autoSign?: boolean; // 每日自动签到
  loginDesktop?: boolean; // 登录 AI 云电脑
  aiChat?: boolean; // 与 AI 对话
  keepAliveHang?: boolean; // 智能补时挂机满1小时
  autoReportActivity?: boolean; // 自动上报事件推进「登录AI云电脑」
  scheduleTime?: string; // 每日做任务时间 (如 08:30)
  lastRunDate?: string; // 上次执行任务日期 YYYY-MM-DD
}

export interface AccountConfig {
  name: string;
  user: string;
  password?: string;
  deviceCode?: string;
  autoStart?: boolean;
  autoSign?: boolean; // 每日自动签到开关 (兼容旧配置)
  lastSignDate?: string; // 上次签到日期 YYYY-MM-DD
  taskConfig?: TaskConfig; // 做任务策略设置
  redeemConfig?: RedeemConfig; // 自动兑换策略设置
  loginInfo?: any;
}

export interface SystemConfig {
  adminPassword?: string;
  keepAliveSeconds?: number;
  webhookUrl?: string; // 消息推送 (如 Server酱 / Bark / Webhook)
}

export class Config {
  public static get dataDir(): string {
    if (process.env.CTYUN_DATA_DIR) {
      return path.resolve(process.env.CTYUN_DATA_DIR);
    }
    if (fs.existsSync('/.dockerenv')) {
      return '/app/data';
    }
    return path.resolve(process.cwd(), 'data');
  }

  public static get configFile(): string {
    if (process.env.CTYUN_CONFIG) {
      return path.resolve(process.env.CTYUN_CONFIG);
    }
    return path.join(this.dataDir, 'config.json');
  }

  public static get accountsFile(): string {
    if (process.env.CTYUN_ACCOUNTS) {
      return path.resolve(process.env.CTYUN_ACCOUNTS);
    }
    return path.join(this.dataDir, 'accounts.json');
  }

  public static get rewardsFile(): string {
    return path.join(this.dataDir, 'rewards.json');
  }

  public static get port(): number {
    return parseInt(process.env.PORT || process.env.CTYUN_PORT || '3088', 10);
  }

  public static get host(): string {
    return process.env.HOST || '0.0.0.0';
  }

  public static initDirs(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  public static generateDeviceCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let rand = '';
    for (let i = 0; i < 32; i++) {
      rand += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 'web_' + rand;
  }

  public static resolveDeviceCode(_accountName?: string, customCode?: string): string {
    if (customCode && customCode.trim()) {
      return customCode.trim();
    }
    return this.generateDeviceCode();
  }
}
