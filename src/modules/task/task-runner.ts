import { CtYunClient } from '../../core/client.js';
import { AiChatTask } from './ai-chat.js';
import { SignTask, type PointsSummary } from './sign.js';
import type { TaskConfig } from '../../config.js';
import { Logger } from '../../core/logger.js';

/**
 * 每日任务统一调度执行器
 * 极简纯净设计：
 * 1. 每日签到打卡（纯 HTTP）
 * 2. 与 AI 助手对话（纯 HTTP，02:00 ~ 06:00 随机错峰执行）
 * 3. 登录打卡与挂机一小时任务已彻底移除，由常驻静默保活 Worker 自动跑满
 */
export interface TaskExecutionSummary {
  sign?: { success: boolean; message: string };
  aiChat?: { success: boolean; message: string };
  totalTodayPoints?: number;
  generalPoints?: number;
}

export class TaskRunner {
  /**
   * 顺序执行今日任务（签到 + AI 对话）
   */
  public static async executeDailyTasks(
    client: CtYunClient,
    taskConfig?: TaskConfig,
    logger?: Logger,
  ): Promise<{ success: boolean; message: string }> {
    const results: string[] = [];

    let taskSummary: PointsSummary | null = null;
    try {
      taskSummary = await SignTask.getPointsAndTasks(client);
    } catch {}

    // 1. 执行签到打卡任务 (+50积分)
    const signTask = taskSummary?.tasks.find((t) => t.type === 'sign');
    const isSigned = !!(signTask && (signTask.isCompleted || signTask.currentProgress >= signTask.totalProgress));

    if (isSigned) {
      results.push('今日已签到 (+50积分)，无需重复执行');
    } else if (!taskConfig || taskConfig.autoSign !== false) {
      let signSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const signRes = await SignTask.signIn(client);
          if (signRes.success) {
            results.push(signRes.message);
            signSuccess = true;
            break;
          }
          if (attempt === 3) {
            results.push(signRes.message);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt === 3) {
            results.push(`签到异常: ${msg}`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    } else {
      results.push('签到: 已按配置跳过');
    }

    // 2. 执行与 AI 助手对话任务 (+100积分)
    const chatTask = taskSummary?.tasks.find((t) => t.type === 'chat');
    const isChatCompleted = !!(chatTask && (chatTask.isCompleted || (chatTask.totalProgress > 0 && chatTask.currentProgress >= chatTask.totalProgress)));

    if (isChatCompleted) {
      results.push('AI助手对话今日已达成 (+100积分)，无需重复执行');
    } else if (!taskConfig || taskConfig.aiChat !== false) {
      let chatSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const chatRes = await AiChatTask.execute(client, logger);
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
            results.push(`AI对话异常: ${msg}`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    } else {
      results.push('AI对话: 已按配置跳过');
    }

    return {
      success: true,
      message: results.join('；'),
    };
  }

  /**
   * 获取积分与任务明细
   */
  public static async getPointsAndTasks(client: CtYunClient): Promise<PointsSummary> {
    return SignTask.getPointsAndTasks(client);
  }
}
