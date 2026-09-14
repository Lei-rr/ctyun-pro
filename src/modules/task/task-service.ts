import type { CtYunClient } from '../../core/client.js';
import type { Logger } from '../../core/logger.js';
import type { TaskConfig } from '../../config.js';
import { SignTask, type PointsSummary } from './sign.js';
import { AiChatTask } from './ai-chat.js';
import { HangTask } from './hang.js';
import { TaskRunner } from './task-runner.js';

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
   * 获取指定账号挂机运行信息
   */
  public getHangInfo(accountName: string) {
    return HangTask.getHangInfo(accountName);
  }

  /**
   * 检查指定账号挂机是否正在运行
   */
  public isHangRunning(accountName: string): boolean {
    return HangTask.isRunning(accountName);
  }

  /**
   * 初始化挂机 Pending 会话
   */
  public initPendingHangSession(accountName: string, currentProgress: number, totalProgress: number): void {
    HangTask.initPendingSession(accountName, currentProgress, totalProgress);
  }

  /**
   * 清理指定账号挂机会话
   */
  public clearHangSession(accountName: string): void {
    HangTask.clearSession(accountName);
  }

  /**
   * 重命名挂机会话账号键
   */
  public renameHangSession(oldName: string, newName: string): void {
    HangTask.renameSession(oldName, newName);
  }

  /**
   * 销毁并停止所有挂机实例
   */
  public async destroyAllHang(): Promise<void> {
    await HangTask.destroy();
  }

  /**
   * 编排并执行指定账号的每日任务集合 (签到、AI对话、活跃唤醒等)
   */
  public async executeDailyTasks(
    client: CtYunClient,
    desktopId?: string,
    taskConfig?: TaskConfig,
    logger?: Logger,
  ) {
    return TaskRunner.executeDailyTasks(client, desktopId, taskConfig, logger);
  }

  /**
   * 纯协议触发官方「登录AI云电脑」任务与活跃事件上报
   */
  public async activateDesktopSession(
    client: CtYunClient,
    desktopId?: string,
    logger?: Logger,
  ) {
    return TaskRunner.activateDesktopSession(client, desktopId, logger);
  }
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
