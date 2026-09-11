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
    // 智能折叠：仅对紧邻的最后一条连续相同心跳执行就地折叠累加与时间更新，保留严格时序轨迹
    const isHeartbeat = message.includes('发送客户端活跃心跳');
    const lastItem = this.logs[this.logs.length - 1];

    if (isHeartbeat && lastItem && lastItem.level === level && lastItem.message === message) {
      lastItem.count = (lastItem.count || 1) + 1;
      lastItem.time = Logger.formatCstTime();
      for (const listener of this.listeners) {
        listener({ ...lastItem });
      }
      return;
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
