import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { APP_VERSION } from '../config.js';
import { globalApiGate } from '../infra/gate.js';
import type { ProfileManager } from '../core/profile-manager.js';
import { errorText } from '../infra/http.js';
import { getCstDateTimeString } from '../infra/time.js';
import { NotifyService } from '../infra/notify.js';
import { sendSuccess, sendError } from '../infra/reply.js';

export const systemRoutes: FastifyPluginAsync<{ manager: ProfileManager }> = async (fastify, { manager }) => {

  // 0. 容器健康检查与监控探针接口 (无需鉴权，供 Docker / K8s / 探针使用)
  fastify.get('/api/health', async () => {
    const summary = manager.getAccountsSummary();
    const totalAccounts = summary.length;
    let totalDesktops = 0;
    let onlineDesktops = 0;
    let pausedDesktops = 0;

    for (const acc of summary) {
      if (acc.desktops) {
        totalDesktops += acc.desktops.length;
        for (const d of acc.desktops) {
          // 保活在线 = connected；yielding = paused (前台/官方客户端占用让位)
          if (d.status === 'connected') onlineDesktops++;
          if (d.status === 'paused') pausedDesktops++;
        }
      }
    }

    const activeWatchdogs = manager.getWatchdogService().getActiveWatchdogCount();
    const memUsage = process.memoryUsage();
    const apiGateMetrics = globalApiGate.getMetrics();

    return {
      status: 'healthy',
      version: APP_VERSION,
      uptime: Math.floor(process.uptime()),
      timestamp: getCstDateTimeString(),
      metrics: {
        totalAccounts,
        totalDesktops,
        onlineDesktops,
        pausedDesktops,
        activeWatchdogs,
        apiGate: apiGateMetrics,
        memory: {
          rssMb: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
      },
    };
  });

  // 1. 获取系统状态 & 账号列表
  fastify.get('/api/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    return sendSuccess(reply, {
      version: APP_VERSION,
      needAuth: Boolean(manager.adminPassword),
      webhookUrl: manager.webhookUrl,
      accounts: manager.getAccountsSummary(),
    });
  });

  // 1.1 更新系统全局配置 (直接回写 data/config.json)
  fastify.post(
    '/api/config/system',
    async (
      request: FastifyRequest<{
        Body: {
          adminPassword?: string;
          webhookUrl?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body || {};
      if (body.adminPassword !== undefined) {
        manager.adminPassword = body.adminPassword.trim();
      }
      if (body.webhookUrl !== undefined) {
        manager.webhookUrl = body.webhookUrl.trim();
      }
      manager.saveToDisk();
      manager.addLog('info', '系统全局配置已持久化至 data/config.json');
      return sendSuccess(reply, null, '系统配置已保存');
    },
  );

  // 1.2 测试 Webhook 推送连通性
  fastify.post(
    '/api/config/webhook/test',
    async (
      request: FastifyRequest<{
        Body: {
          webhookUrl?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body || {};
      const targetUrl = (body.webhookUrl || manager.webhookUrl || '').trim();
      if (!targetUrl) {
        return sendError(reply, '请先填写 Webhook 推送地址');
      }

      const nowStr = getCstDateTimeString();
      const success = await NotifyService.sendNotification(
        targetUrl,
        'CTYUN-PRO - Webhook 通知测试',
        `Webhook 消息通知已成功连通。\n\n• 测试结果: 通信正常\n• 发送时间: ${nowStr}\n• 推送规则: 严格精简推送，仅在凭证失效、兑换成功、重试熔断及每日早报 (09:00) 时通知，杜绝日常琐碎流水刷屏。`,
      );

      if (success) {
        return sendSuccess(reply, null, '测试消息已成功送达，请前往对应渠道查收！');
      } else {
        return sendError(reply, '测试推送失败，请检查 Webhook 地址格式或宿主机网络连通性');
      }
    },
  );

  // 1.3 导出安全配置备份
  fastify.get('/api/config/export', async (_request: FastifyRequest, reply: FastifyReply) => {
    return sendSuccess(reply, manager.exportConfigSafe());
  });

  // 1.4 导入配置备份
  fastify.post('/api/config/import', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body;
      const res = manager.importConfigSafe(body);
      manager.addLog('info', `配置导入成功，已恢复 ${res.importedAccounts} 个账号配置`);
      return sendSuccess(reply, res, `配置恢复成功，已导入 ${res.importedAccounts} 个账号配置`);
    } catch (err) {
      const msg = errorText(err);
      return sendError(reply, `配置导入失败: ${msg}`);
    }
  });
};
