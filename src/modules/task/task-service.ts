import type { CtYunClient } from '../../core/client.js';
import type { Logger } from '../../core/logger.js';
import { SignTask, type PointsSummary } from './sign.js';
import { AiChatTask } from './ai-chat.js';
import { HangTask } from './hang.js';

export interface TaskExecutionSummary {
  accountName: string;
  signResult?: { success: boolean; message: string; points?: number };
  aiChatResult?: { success: boolean; message: string };
  hangResult?: { success: boolean; message: string; isCompleted?: boolean };
  executedAt: number;
}

export class TaskStrategyService {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  public setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * 执行每日轻量签到任务
   */
  public async executeSign(client: CtYunClient): Promise<{ success: boolean; message: string; points?: number }> {
    return SignTask.signIn(client);
  }

  /**
   * 执行每日 AI 对话任务
   */
  public async executeAiChat(client: CtYunClient): Promise<{ success: boolean; message: string }> {
    return AiChatTask.execute(client);
  }

  /**
   * 触发执行挂机任务（通过长连接仲裁器隔离）
   */
  public async executeHang(
    accountName: string,
    client: CtYunClient,
    onProgress?: (cur: number, total: number) => void,
  ): Promise<{ success: boolean; message: string; isCompleted?: boolean }> {
    if (!this.logger) {
      throw new Error('Logger 未初始化');
    }
    return HangTask.executeSmartHang(accountName, client, this.logger, onProgress);
  }

  /**
   * 停止指定账号正在运行的挂机任务
   */
  public async stopHang(accountName: string): Promise<void> {
    await HangTask.stopHang(accountName);
  }

  /**
   * 查询指定账号今日积分与任务完成度
   */
  public async getPointsAndTasks(client: CtYunClient): Promise<PointsSummary> {
    return SignTask.getPointsAndTasks(client);
  }
}
