import { getCstTimeString } from './time.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

/** 日志来源模块 (前端按此着色并支持过滤) */
export type LogSource =
  | 'system'
  | 'account'
  | 'keepalive'
  | 'watchdog'
  | 'task'
  | 'redeem'
  | 'power'
  | 'proxy'
  | 'api';

export interface LogMeta {
  source?: LogSource;
  account?: string;
  desktop?: string;
  /** 相同 foldKey 的相邻日志折叠为一条并累加计数 (如心跳)；遇到其他日志即打断折叠窗口 */
  foldKey?: string;
}

export interface LogItem {
  id: number;
  time: string;
  level: LogLevel;
  source: LogSource;
  account?: string;
  desktop?: string;
  message: string;
  count?: number;
}

/** 拼接 [账号 - 桌面] 展示前缀 (仅用于终端文本输出) */
export function formatLogPrefix(meta?: Pick<LogMeta, 'account' | 'desktop'>): string {
  if (!meta?.account) return '';
  return meta.desktop ? `${meta.account} - ${meta.desktop}` : meta.account;
}

export class Logger {
  private logs: LogItem[] = [];
  private logId = 0;
  private listeners: Set<(log: LogItem) => void> = new Set();

  public addLog(level: LogLevel, message: string, meta: LogMeta = {}): void {
    const source = meta.source || 'system';
    const foldKey = meta.foldKey;

    // 折叠窗口: 仅当上一条为相同 foldKey 且中间无其他日志时累计 (不跨事件回溯)
    if (foldKey) {
      const last = this.logs[this.logs.length - 1];
      if (last && last.level === level && last.source === source && last.message === message && this.foldKeys.get(last.id) === foldKey) {
        last.count = (last.count || 1) + 1;
        last.time = getCstTimeString();
        this.emit(last);
        return;
      }
    }

    const item: LogItem = {
      id: ++this.logId,
      time: getCstTimeString(),
      level,
      source,
      account: meta.account,
      desktop: meta.desktop,
      message,
      count: 1,
    };
    this.logs.push(item);
    if (foldKey) this.foldKeys.set(item.id, foldKey);
    if (this.logs.length > 1000) {
      const dropped = this.logs.shift();
      if (dropped) this.foldKeys.delete(dropped.id);
    }
    this.emit(item);
  }

  private foldKeys = new Map<number, string>();

  private emit(item: LogItem): void {
    this.mirrorToStdout(item);
    for (const listener of this.listeners) {
      try {
        listener({ ...item });
      } catch {}
    }
  }

  /** 镜像到标准输出 (容器环境可用 docker logs 直接查看，不依赖前端) */
  private mirrorToStdout(item: LogItem): void {
    if (process.env.CTYUN_LOG_STDOUT === '0') return;
    const prefix = item.account ? ` ${item.account}${item.desktop ? '/' + item.desktop : ''}` : '';
    const fold = item.count && item.count > 1 ? ` (x${item.count})` : '';
    const line = `${item.time}${prefix} ${item.message}${fold}`;
    if (item.level === 'error') console.error(line);
    else if (item.level === 'warn') console.warn(line);
    else console.log(line);
  }

  public getRecentLogs(): LogItem[] {
    return [...this.logs];
  }

  public clearLogs(): void {
    this.logs = [];
    this.foldKeys.clear();
    for (const listener of this.listeners) {
      listener({ id: 0, time: '', level: 'info', source: 'system', message: '__CLEAR__' });
    }
  }

  public subscribe(listener: (log: LogItem) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
