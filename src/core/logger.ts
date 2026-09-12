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
    // 智能折叠：在当前连续心跳波次（Block）内寻找同账号/同级别心跳折叠；一旦遇到非心跳业务日志立即打断，绝不跨事件回溯
    const isHeartbeat = message.includes('发送客户端活跃心跳');
    if (isHeartbeat) {
      for (let i = this.logs.length - 1; i >= 0; i--) {
        const item = this.logs[i];
        const itemIsHeartbeat = item.message && item.message.includes('发送客户端活跃心跳');
        if (!itemIsHeartbeat) {
          // 遇到业务/报警日志，打断回溯，保证前后周期严格隔离
          break;
        }
        if (item.level === level && item.message === message) {
          // 匹配成功：从原位置取出，增加计数并更新时间，推入末尾（置底），避免刷屏同时保持最新活跃心跳处于最底端
          const [matched] = this.logs.splice(i, 1);
          matched.count = (matched.count || 1) + 1;
          matched.time = Logger.formatCstTime();
          this.logs.push(matched);
          for (const listener of this.listeners) {
            listener({ ...matched });
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
