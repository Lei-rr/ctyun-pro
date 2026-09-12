import { getRandomScheduleTime } from '../../config.js';

export interface StrategyPlan {
  scheduleTime: string; // 格式如 "04:23"
  enableSign: boolean;
  enableHang: boolean;
  enableAiChat: boolean;
  enableRedeem: boolean;
}

export class StrategyService {
  /**
   * 生成防风控错峰随机执行时间 (00:00 ~ 08:59)
   */
  public static generateRandomSchedule(): string {
    return getRandomScheduleTime();
  }

  /**
   * 校验设定的调度时间是否合法
   */
  public static isValidScheduleTime(timeStr: string): boolean {
    if (!timeStr || typeof timeStr !== 'string') return false;
    const parts = timeStr.split(':');
    if (parts.length !== 2) return false;
    const hour = parseInt(parts[0], 10);
    const minute = parseInt(parts[1], 10);
    return !isNaN(hour) && !isNaN(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  }
}
