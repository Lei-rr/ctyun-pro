import { CtYunClient } from '../../core/client.js';
import { AiChatTask } from './ai-chat.js';
import { SignTask, type PointsSummary } from './sign.js';
import { HangTask } from './hang.js';
import { safeFetch } from '../../core/utils.js';
import type { TaskConfig } from '../../config.js';
import type { Logger } from '../../core/logger.js';

/**
 * 每日任务统一调度执行器
 * 核心设计：
 * 1. 任务解耦：日常 3 任务（签到打卡、AI 对话、登录云电脑）与「挂机1小时」彻底解耦，挂机开关关闭绝对不影响 3 任务；
 * 2. 协议合一：「登录云电脑」与「挂机1小时」共享同一套轻量级 Clink 纯协议通道：
 *    - 仅需登录云电脑：协议握手发送 112+104 认领桌面会话并上报客户端事件后，立即安全断开完成打卡 (+100积分)；
 *    - 若开启挂机：不重复建立连接，原地维持 5 秒 Type 7 心跳跑满 3600 秒 (+100积分)。
 * 3. 彻底砍掉 Chromium/Playwright 浏览器以及 Windows 外部环境依赖。
 */
export class TaskRunner {
  /**
   * 纯协议触发官方「登录AI云电脑」任务与活跃事件上报
   * 双保险：先调数据事件批量上报接口 (11101 & 10109)，再建 Clink 纯协议通道握手认领会话
   */
  public static async activateDesktopSession(
    client: CtYunClient,
    desktopId?: string,
    logger?: Logger,
  ): Promise<{ success: boolean; message: string }> {
    if (!client.loginInfo) {
      return { success: false, message: '未登录无法激活会话' };
    }

    try {
      const dId = desktopId;
      if (!dId) {
        return { success: false, message: '未找到可用云电脑，无法激活桌面会话' };
      }

      // 1. 官方事件中心批量上报：APP_VISIT (11101) 与 ENTER_DESKTOP (10109)
      try {
        const events = [
          {
            bussiKey: 11101,
            bussiValue: 0,
            eventTime: Date.now(),
            eventName: 'client_action',
            userId: client.loginInfo.userId,
            userAccount: client.loginInfo.userName,
            tenantId: client.loginInfo.tenantId,
            deviceCode: client.getDeviceCode(),
            deviceOsType: 'web',
            deviceOsVersion: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            deviceModel: 'PC',
            clientVersionCode: '3.7.0',
            clientVersionName: '3.7.0',
            opLocalTimeStamp: Date.now(),
            appType: 6,
            desktopId: dId,
            ctgDeviceType: '60',
            ctgAppModel: 'PC',
            vmUuid: dId,
            timeInterval: new Date().getHours(),
            host: 'pc.ctyun.cn',
            uploadTimeStamp: Date.now(),
          },
          {
            bussiKey: 10109,
            bussiValue: 0,
            eventTime: Date.now(),
            eventName: 'client_action',
            userId: client.loginInfo.userId,
            userAccount: client.loginInfo.userName,
            tenantId: client.loginInfo.tenantId,
            deviceCode: client.getDeviceCode(),
            deviceOsType: 'web',
            deviceOsVersion: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            deviceModel: 'PC',
            clientVersionCode: '3.7.0',
            clientVersionName: '3.7.0',
            opLocalTimeStamp: Date.now(),
            appType: 6,
            desktopId: dId,
            ctgDeviceType: '60',
            ctgAppModel: 'PC',
            vmUuid: dId,
            timeInterval: new Date().getHours(),
            host: 'pc.ctyun.cn',
            uploadTimeStamp: Date.now(),
          },
        ];

        await safeFetch(
          `${client.baseUrl}/api/cdserv/client/dataservice/api/dataEvent/sendBatch`,
          {
            method: 'POST',
            headers: {
              ...client.getHeaders(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(events),
          },
        );
      } catch {}

      // 2. 调用纯协议 Clink 握手完成会话认领 (Type 112 + Type 104)
      if (logger) {
        const protoRes = await HangTask.executeProtocolHang(
          client.loginInfo.userName,
          client,
          logger,
          {
            onlyLoginTask: true,
            desktopId: dId,
          },
        );
        return { success: protoRes.success, message: protoRes.message };
      }

      return { success: true, message: '已激活云电脑桌面会话 (完成登录云电脑)' };
    } catch (err: any) {
      return { success: false, message: `激活会话异常: ${err.message}` };
    }
  }

  /**
   * 一键执行每日全部自动任务 (任务间彻底解耦，按配置精准跳过)
   */
  public static async executeDailyTasks(
    client: CtYunClient,
    desktopId?: string,
    taskConfig?: TaskConfig,
    logger?: Logger,
  ): Promise<{ success: boolean; message: string }> {
    if (taskConfig && taskConfig.enabled === false) {
      return { success: true, message: '每日任务总开关已关闭，跳过执行' };
    }

    // 0. 前置拉取官方任务中心最新状态（精准幂等，防重复打断保活与多余接口请求）
    let taskSummary: PointsSummary | null = null;
    try {
      taskSummary = await SignTask.getPointsAndTasks(client);
    } catch (e: any) {
      logger?.addLog('warn', `前置核验任务状态提示: ${e.message}，将执行常规流程`);
    }

    const results: string[] = [];

    // 1. 每日签到打卡 (+100积分)
    if (!taskConfig || taskConfig.autoSign !== false) {
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
        } catch (e: any) {
          if (attempt === 3) {
            results.push(`签到异常: ${e.message}`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    } else {
      results.push('每日签到: 已按配置跳过');
    }

    // 2. 触发官方「与AI对话1次」任务 (+100积分)
    const chatTask = taskSummary?.tasks.find((t) => t.type === 'chat');
    const isChatCompleted = !!(chatTask && (chatTask.isCompleted || (chatTask.totalProgress > 0 && chatTask.currentProgress >= chatTask.totalProgress)));

    if (isChatCompleted) {
      results.push('官方AI对话今日已达成 (+100积分)，无需重复执行');
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
        } catch (e: any) {
          if (attempt === 3) {
            results.push(`AI对话异常: ${e.message}`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    } else {
      results.push('AI对话: 已按配置跳过');
    }

    // 3. 激活官方桌面会话，推进「登录AI云电脑」任务 (+100积分)
    const loginTask = taskSummary?.tasks.find((t) => t.type === 'login');
    const isLoginCompleted = !!(loginTask && (loginTask.isCompleted || (loginTask.totalProgress > 0 && loginTask.currentProgress >= loginTask.totalProgress)));

    if (isLoginCompleted) {
      results.push('纯协议桌面登录今日已达成 (+100积分)，无需重复执行');
    } else if (!taskConfig || taskConfig.loginDesktop !== false) {
      let actSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const actRes = await TaskRunner.activateDesktopSession(client, desktopId, logger);
          if (actRes.success) {
            results.push(actRes.message);
            actSuccess = true;
            break;
          }
          if (attempt === 3) {
            results.push(actRes.message);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (e: any) {
          if (attempt === 3) {
            results.push(`会话激活异常: ${e.message}`);
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    } else {
      results.push('登录云电脑: 已按配置跳过');
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
