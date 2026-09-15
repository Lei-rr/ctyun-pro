import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { ProfileManager } from '../core/index.js';
import type { AuthContext } from './auth.js';
import { sendWebhookNotification, getCstDateTimeString } from '../core/utils.js';

export const systemRoutes: FastifyPluginAsync<{
  manager: ProfileManager;
  authContext: AuthContext;
}> = async (fastify, { manager, authContext }) => {
  const { verifyAuth } = authContext;

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
          if (d.status === 'running') onlineDesktops++;
          if (d.status === 'paused') pausedDesktops++;
        }
      }
    }

    const activeWatchdogs = manager.getWatchdogService().getActiveCount();
    const memUsage = process.memoryUsage();

    return {
      status: 'healthy',
      uptime: Math.floor(process.uptime()),
      timestamp: getCstDateTimeString(),
      metrics: {
        totalAccounts,
        totalDesktops,
        onlineDesktops,
        pausedDesktops,
        activeWatchdogs,
        memory: {
          rssMb: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
      },
    };
  });

  // 1. 获取系统状态 & 账号列表
  fastify.get('/api/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    return {
      success: true,
      data: {
        needAuth: Boolean(manager.adminPassword),
        webhookUrl: manager.webhookUrl,
        keepAliveSeconds: manager.keepAliveSeconds,
        accounts: manager.getAccountsSummary(),
      },
    };
  });

  // 1.1 更新系统全局配置 (直接回写 data/config.json)
  fastify.post(
    '/api/config/system',
    async (
      request: FastifyRequest<{
        Body: {
          keepAliveSeconds?: number;
          adminPassword?: string;
          webhookUrl?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const body = request.body || {};
      if (body.keepAliveSeconds !== undefined && body.keepAliveSeconds >= 10) {
        manager.keepAliveSeconds = body.keepAliveSeconds;
      }
      if (body.adminPassword !== undefined) {
        manager.adminPassword = body.adminPassword.trim();
      }
      if (body.webhookUrl !== undefined) {
        manager.webhookUrl = body.webhookUrl.trim();
      }
      manager.saveToDisk();
      manager.addLog('info', '系统全局配置已持久化至 data/config.json');
      return { success: true };
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
      if (!verifyAuth(request, reply)) return;
      const body = request.body || {};
      const targetUrl = (body.webhookUrl || manager.webhookUrl || '').trim();
      if (!targetUrl) {
        return reply.send({ success: false, msg: '请先填写 Webhook 推送地址' });
      }

      const nowStr = getCstDateTimeString();
      const success = await sendWebhookNotification(
        targetUrl,
        'CTYUN-PRO - Webhook 通知测试',
        `Webhook 消息通知已成功连通。\n\n• 测试结果: 通信正常\n• 发送时间: ${nowStr}\n• 推送规则: 严格精简推送，仅在凭证失效、兑换成功、重试熔断及每日早报 (09:00) 时通知，杜绝日常琐碎流水刷屏。`,
      );

      if (success) {
        return reply.send({ success: true, msg: '测试消息已成功送达，请前往对应渠道查收！' });
      } else {
        return reply.send({
          success: false,
          msg: '测试推送失败，请检查 Webhook 地址格式或宿主机网络连通性',
        });
      }
    },
  );

  // 2.4 导出安全配置备份
  fastify.get('/api/config/export', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    return { success: true, data: manager.exportConfigSafe() };
  });

  // 2.5 导入配置备份
  fastify.post('/api/config/import', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    try {
      const body = request.body;
      const res = manager.importConfigSafe(body);
      manager.addLog('info', `配置导入成功，已恢复 ${res.importedAccounts} 个账号配置`);
      return { success: true, msg: `配置恢复成功，已导入 ${res.importedAccounts} 个账号配置`, data: res };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ success: false, msg: `配置导入失败: ${msg}` });
    }
  });
};
