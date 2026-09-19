import { CtYunClient } from '../../ctyun/client.js';
import { errorText } from '../../infra/http.js';
import { AiChatTask } from './ai-chat.js';
import { PointsTask, TASK_STATUS, type PointsSummary, type TaskItem } from './points.js';
import type { TaskConfig } from '../../config.js';
import { Logger } from '../../infra/logger.js';

/**
 * 每日任务统一调度执行器
 * 极简纯净设计：
 * 1. 与 AI 助手对话（纯 HTTP，03:00 ~ 06:00 随机错峰执行）
 * 2. 自动领取达到条件的任务奖励（官方 status=1 待领取）
 * 3. 挂机与活跃状态由常驻静默保活 Worker 自动跑满
 */
export interface TaskExecutionSummary {
  aiChat?: { success: boolean; message: string };
  totalTodayPoints?: number;
  generalPoints?: number;
}

export class TaskRunner {
  /**
   * 自动领取所有「待领取」状态的任务奖励
   * 仅领取平台积分(通用1/专属10)任务奖励，九江专属积分(20)任务不纳入自动领取范围
   */
  private static async claimPendingTasks(
    client: CtYunClient,
    tasks: TaskItem[],
    logger?: Logger,
  ): Promise<string[]> {
    const messages: string[] = [];
    const pending = tasks.filter(
      (t) => t.status === TASK_STATUS.UNCLAIMED && t.points.some((p) => p.type === 1 || p.type === 10),
    );
    for (const task of pending) {
      try {
        const res = await PointsTask.receivePoints(client, task);
        if (res.success) {
          messages.push(`已领取 [${task.name}] (+${task.rewardPoints}积分)`);
          logger?.addLog('success', `任务奖励领取成功: [${task.name}] (+${task.rewardPoints}积分)`);
        } else {
          messages.push(`领取 [${task.name}] 失败: ${res.message}`);
          logger?.addLog('warn', `任务奖励领取失败: [${task.name}] ${res.message}`);
        }
      } catch (e) {
        const msg = errorText(e);
        messages.push(`领取 [${task.name}] 异常: ${msg}`);
        logger?.addLog('warn', `任务奖励领取异常: [${task.name}] ${msg}`);
      }
      // 领取接口之间保持轻微间隔，规避频控
      await new Promise((r) => setTimeout(r, 800));
    }
    return messages;
  }

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

    // 1. 优先自动领取所有已达到条件的「待领取」任务奖励
    if (taskSummary) {
      const claimMessages = await this.claimPendingTasks(client, taskSummary.tasks, logger);
      results.push(...claimMessages);
    }

    // 2. 执行 AI 对话交互任务 (+100积分)
    const chatTask = taskSummary?.tasks.find((t) => t.type === 'chat');
    const isChatCompleted = !!(
      chatTask &&
      (chatTask.isCompleted || chatTask.canClaim || chatTask.status === TASK_STATUS.UNCLAIMED)
    );

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
          const msg = errorText(e);
          if (attempt === 3) {
            results.push(`AI 对话异常: ${msg}`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }

      // AI 对话完成后，再次尝试领取本次产生的待领取奖励
      if (chatSuccess) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const afterSummary = await PointsTask.getPointsAndTasks(client);
          const claimAfter = await this.claimPendingTasks(client, afterSummary.tasks, logger);
          if (claimAfter.length > 0) {
            results.push(...claimAfter);
          }
        } catch {}
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
