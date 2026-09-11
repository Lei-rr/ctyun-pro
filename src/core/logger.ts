export interface LogItem {
  id: number;
  time: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  count?: number;
}

export class Logger {
  private logs: LogItem[] = [];
  private logId = 0;
  private listeners: Set<(log: LogItem) => void> = new Set();

  public static formatCstTime(date: Date = new Date()): string {
    return date.toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });
  }

  public addLog(level: 'info' | 'warn' | 'error' | 'success', message: string): void {
    // 智能折叠：仅对心跳日志执行折叠置底防刷屏，其他业务与报警日志严格独立记录以保证排查透明
    const isHeartbeat = message.includes('发送客户端活跃心跳');
    if (isHeartbeat) {
      const searchLimit = Math.max(0, this.logs.length - 10);
      for (let i = this.logs.length - 1; i >= searchLimit; i--) {
        const item = this.logs[i];
        if (item.level === level && item.message === message) {
          item.count = (item.count || 1) + 1;
          item.time = Logger.formatCstTime();
          // 如果不是最后一条，移至末尾，保证最新活动的一条始终排在最底部！
          if (i !== this.logs.length - 1) {
            this.logs.splice(i, 1);
            this.logs.push(item);
          }
          for (const listener of this.listeners) {
            listener({ ...item });
          }
          return;
        }
      }
    }

    const item: LogItem = {
      id: ++this.logId,
      time: Logger.formatCstTime(),
      level,
      message,
      count: 1,
    };
    this.logs.push(item);
    if (this.logs.length > 200) {
      this.logs.shift();
    }
    for (const listener of this.listeners) {
      listener(item);
    }
  }

  public getRecentLogs(): LogItem[] {
    return [...this.logs];
  }

  public clearLogs(): void {
    this.logs = [];
    for (const listener of this.listeners) {
      listener({ id: 0, time: '', level: 'info', message: '__CLEAR__' });
    }
  }

  public subscribe(listener: (log: LogItem) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
