import { CtYunClient } from '../../core/client.js';
import { AiChatTask } from './ai-chat.js';
import { PointsTask, type PointsSummary } from './points.js';
import type { TaskConfig } from '../../config.js';
import { Logger } from '../../core/logger.js';

/**
 * 每日任务统一调度执行器
 * 极简纯净设计：
 * 1. 与 AI 助手对话（纯 HTTP，06:00 ~ 08:00 随机错峰执行）
 * 2. 挂机与活跃状态由常驻静默保活 Worker 自动跑满
 */
export interface TaskExecutionSummary {
  aiChat?: { success: boolean; message: string };
  totalTodayPoints?: number;
  generalPoints?: number;
}

export class TaskRunner {
  /**
   * 顺序执行今日任务（AI 对话）
   */
  public static async executeDailyTasks(
    client: CtYunClient,
    taskConfig?: TaskConfig,
    logger?: Logger,
  ): Promise<{ success: boolean; message: string }> {
    const results: string[] = [];

    let taskSummary: PointsSummary | null = null;
    try {
      taskSummary = await PointsTask.getPointsAndTasks(client);
    } catch {}

    // 执行 AI 对话交互任务 (+100积分)
    const chatTask = taskSummary?.tasks.find((t) => t.type === 'chat');
    const isChatCompleted = !!(chatTask && (chatTask.isCompleted || chatTask.currentProgress >= chatTask.totalProgress));

    if (isChatCompleted) {
      results.push('今日已完成 AI 对话 (+100积分)，无需重复执行');
    } else if (!taskConfig || taskConfig.aiChat !== false) {
      let chatSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const chatRes = await AiChatTask.execute(client);
          if (chatRes.success) {
            results.push(chatRes.message);
            chatSuccess = true;
            break;
          }
          if (attempt === 3) {
            results.push(chatRes.message);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt === 3) {
            results.push(`AI 对话异常: ${msg}`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    } else {
      results.push('AI 对话: 已按配置跳过');
    }

    // 汇总执行后最新积分
    let finalGeneralPoints = 0;
    let todayEarnedPoints = 0;
    try {
      const finalSummary = await PointsTask.getPointsAndTasks(client);
      finalGeneralPoints = finalSummary.generalPoints;
      todayEarnedPoints = finalSummary.tasks.reduce((sum, t) => {
        return sum + (t.isCompleted ? t.rewardPoints : 0);
      }, 0);
    } catch {}

    const fullMessage = results.join('；');
    return {
      success: true,
      message: `${fullMessage} (今日任务已获 ${todayEarnedPoints} 积分，总可用 ${finalGeneralPoints} 积分)`,
    };
  }

  /**
   * 仅获取积分与任务状态
   */
  public static async getPointsAndTasks(client: CtYunClient): Promise<PointsSummary> {
    return PointsTask.getPointsAndTasks(client);
  }
}
