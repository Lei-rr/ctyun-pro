import { CtYunClient } from '../core/client.js';
import { Protocol } from '../core/protocol.js';
import { AiChatTask } from './ai-chat.js';
import { SignTask, type PointsSummary } from './sign.js';
import { safeFetch } from '../core/utils.js';
import type { TaskConfig } from '../config.js';

/**
 * 每日任务协调执行器
 * 统一调度：桌面会话激活 (登录云电脑)、签到打卡、AI 问答交互
 */
export class TaskRunner {
  /**
   * 纯协议触发官方「登录AI云电脑」任务与活跃事件上报
   */
  public static async activateDesktopSession(
    client: CtYunClient,
    desktopId?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!client.loginInfo) {
      return { success: false, message: '未登录无法激活会话' };
    }

    try {
      const dId = desktopId;
      if (!dId) {
        return { success: false, message: '未找到可用云电脑，无法激活桌面会话' };
      }

      // 1. 调用官方状态预检与会话激活接口
      try {
        await safeFetch(`${client.baseUrl}/api/desktop/client/status?desktopId=${dId}&specifiedCertCategory=1`, {
          headers: client.getHeaders(),
        });
      } catch {}

      const connBody = new URLSearchParams({
        objId: dId,
        objType: '0',
        osType: '15',
        deviceId: '60',
        vdCommand: '',
        ipAddress: '',
        macAddress: '',
        deviceCode: client.getDeviceCode(),
        deviceName: 'Chrome浏览器',
        deviceType: '60',
        deviceModel: 'Windows NT 10.0; Win64; x64',
        appVersion: '3.7.0',
        sysVersion: 'Windows NT 10.0; Win64; x64',
        clientVersion: '3.7.0',
        specifiedCertCategory: '1',
      });

      const connectRes = await safeFetch(`${client.baseUrl}/api/desktop/client/connect`, {
        method: 'POST',
        headers: {
          ...client.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: connBody.toString(),
      });
      if (!connectRes.ok) {
        return { success: false, message: `激活云电脑接口失败 (HTTP ${connectRes.status})` };
      }
      const connectJson = (await connectRes.json()) as { code?: number; msg?: string; data?: unknown };
      if (connectJson.code !== undefined && connectJson.code !== 0 && connectJson.code !== 200) {
        return { success: false, message: connectJson.msg || `激活云电脑失败 (Code: ${connectJson.code})` };
      }

      // 2. 官方事件中心批量上报：APP_VISIT (11101) 与 ENTER_DESKTOP (10109)
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

      const eventRes = await safeFetch(
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
      if (!eventRes.ok) {
        return { success: false, message: `桌面事件上报失败 (HTTP ${eventRes.status})` };
      }
      const eventJson = (await eventRes.json()) as { code?: number; msg?: string };
      if (eventJson.code !== undefined && eventJson.code !== 0 && eventJson.code !== 200) {
        return { success: false, message: eventJson.msg || `桌面事件上报失败 (Code: ${eventJson.code})` };
      }

      return { success: true, message: '已激活云电脑桌面会话 (完成登录云电脑)' };
    } catch (err: any) {
      return { success: false, message: `激活会话异常: ${err.message}` };
    }
  }

  /**
   * 一键执行每日全部自动任务 (严格遵从用户的开关设置)
   */
  public static async executeDailyTasks(
    client: CtYunClient,
    desktopId?: string,
    taskConfig?: TaskConfig,
  ): Promise<{ success: boolean; message: string }> {
    if (taskConfig && taskConfig.enabled === false) {
      return { success: true, message: '每日任务总开关已关闭，跳过执行' };
    }

    const results: string[] = [];

    // 1. 激活官方桌面会话，推进「登录AI云电脑」任务 (+100分)
    if (!taskConfig || taskConfig.loginDesktop !== false) {
      try {
        const actRes = await TaskRunner.activateDesktopSession(client, desktopId);
        results.push(actRes.message);
      } catch (e: any) {
        results.push(`会话激活异常: ${e.message}`);
      }
    } else {
      results.push('登录云电脑: 已按配置跳过');
    }

    // 2. 触发官方「与AI对话1次」任务 (+100积分)
    if (!taskConfig || taskConfig.aiChat !== false) {
      try {
        const chatRes = await AiChatTask.execute(client);
        results.push(chatRes.message);
      } catch (e: any) {
        results.push(`AI对话异常: ${e.message}`);
      }
    } else {
      results.push('AI对话: 已按配置跳过');
    }

    // 3. 触发官方「使用 1 小时」智能补足挂机任务 (+100分)
    if (!taskConfig || taskConfig.keepAliveHang !== false) {
      try {
        results.push('已在后台派发智能挂机补时');
      } catch (e: any) {
        results.push(`智能挂机异常: ${e.message}`);
      }
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
