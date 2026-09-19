import { CtYunClient } from '../../ctyun/client.js';
import { errorText } from '../../infra/http.js';
import { AiChatTask } from './ai-chat.js';
import { PointsTask, TASK_STATUS, type PointsSummary } from './points.js';
import type { TaskConfig } from '../../config.js';
import { Logger } from '../../infra/logger.js';

/**
 * 每日任务统一调度执行器
 *
 * 官方桌面积分任务为「完成即自动到账」(taskList 中 status 直接置 2)，
 * 无手动领取环节 (桌面积分中心 0 引用 receivePointsV2)，故本执行器仅负责：
 * 1. 与 AI 助手对话 (纯 HTTP，03:00~06:00 随机错峰)
 * 2. 挂机与活跃由常驻静默保活 Worker 自动跑满
 */
export interface TaskExecutionSummary {
  aiChat?: { success: boolean; message: string };
  totalTodayPoints?: number;
  generalPoints?: number;
}

export class TaskRunner {
  /**
   * 顺序执行今日任务（领取奖励 + AI 对话）
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
    const isChatCompleted = !!chatTask && chatTask.status === TASK_STATUS.DONE;

    if (isChatCompleted) {
      results.push('今日已完成 AI 对话 (+100积分)，无需重复执行');
    } else if (!taskConfig || taskConfig.aiChat !== false) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const chatRes = await AiChatTask.execute(client);
          if (chatRes.success) {
            results.push(chatRes.message);
            break;
          }
          if (attempt === 3) {
            results.push(chatRes.message);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (e) {
          const msg = errorText(e);
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
      // 今日已获积分 = 所有已领取(status=2)任务奖励之和
      todayEarnedPoints = finalSummary.tasks.reduce((sum, t) => {
        return sum + (t.status === TASK_STATUS.DONE ? t.rewardPoints : 0);
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
