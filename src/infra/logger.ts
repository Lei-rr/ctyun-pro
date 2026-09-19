import { getCstTimeString } from './time.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogMeta {
  account?: string;
  desktop?: string;
  /** 相同 foldKey 的相邻日志折叠为一条并累加计数 (如心跳)；遇其他日志即打断折叠窗口 */
  foldKey?: string;
}

export interface LogItem {
  id: number;
  time: string;
  level: LogLevel;
  account?: string;
  desktop?: string;
  message: string;
  count?: number;
}

export class Logger {
  private logs: LogItem[] = [];
  private logId = 0;
  private foldKeys = new Map<number, string>();
  private listeners: Set<(log: LogItem) => void> = new Set();

  public addLog(level: LogLevel, message: string, meta: LogMeta = {}): void {
    // 折叠作用域必须包含账号/桌面，否则多账号的相同日志会被错误合并
    const scope = `${meta.account || ''}\u0000${meta.desktop || ''}`;
    const baseKey = meta.foldKey;
    const scopedKey = baseKey ? `${baseKey}\u0000${scope}` : undefined;

    // 折叠窗口: 从末尾回溯同类 foldKey 的连续日志 (中途插入的其他账号/桌面同类日志不打断窗口)，
    // 一旦遇到不同 foldKey 的业务日志立即停止，绝不跨事件回溯
    if (baseKey && scopedKey) {
      for (let i = this.logs.length - 1; i >= 0; i--) {
        const item = this.logs[i];
        const itemKey = this.foldKeys.get(item.id);
        if (!itemKey || !itemKey.startsWith(`${baseKey}\u0000`)) break;
        if (itemKey === scopedKey && item.level === level && item.message === message) {
          const [matched] = this.logs.splice(i, 1);
          matched.count = (matched.count || 1) + 1;
          matched.time = getCstTimeString();
          this.logs.push(matched);
          this.emit(matched);
          return;
        }
      }
    }

    const item: LogItem = {
      id: ++this.logId,
      time: getCstTimeString(),
      level,
      account: meta.account,
      desktop: meta.desktop,
      message,
      count: 1,
    };
    this.logs.push(item);
    if (scopedKey) this.foldKeys.set(item.id, scopedKey);
    if (this.logs.length > 1000) {
      const dropped = this.logs.shift();
      if (dropped) this.foldKeys.delete(dropped.id);
    }
    this.emit(item);
  }

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
    const prefix = item.account ? ` [${item.account}${item.desktop ? ' - ' + item.desktop : ''}]` : '';
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
      listener({ id: 0, time: '', level: 'info', message: '__CLEAR__' });
    }
  }

  public subscribe(listener: (log: LogItem) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
