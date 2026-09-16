import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { ProfileManager } from '../core/index.js';
import type { AccountConfig } from '../config.js';
import type { AuthContext } from './auth.js';
import { sendSuccess, sendError } from '../common/response.js';

export const taskRoutes: FastifyPluginAsync<{
  manager: ProfileManager;
  authContext: AuthContext;
}> = async (fastify, { manager, authContext }) => {
  const { verifyAuth } = authContext;

  // 辅助函数：根据 Profile ID 校验并获取有效账号
  const resolveAccount = (id: string, reply: FastifyReply): AccountConfig | null => {
    const acc = manager.getAccount(id);
    if (!acc) {
      sendError(reply, 'Profile 未找到', 404);
      return null;
    }
    return acc;
  };

  // 1. 查询任务进度和积分信息
  fastify.get(
    '/api/profiles/:id/tasks',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      try {
        const data = await manager.getPointsAndTasks(acc.name);
        return sendSuccess(reply, data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, msg);
      }
    },
  );

  // 2. 手动执行 AI 对话互动任务
  fastify.post(
    '/api/profiles/:id/tasks/chat',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      try {
        const msg = await manager.manualAiChat(acc.name);
        return sendSuccess(reply, null, msg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, msg);
      }
    },
  );

  // 3. 手动执行积分兑换
  fastify.post(
    '/api/profiles/:id/tasks/redeem',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          desktopCode?: string;
          desktopId?: string;
          prodId?: string | number;
          costPoints?: number;
          prodType?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;

      const body = request.body || {};
      const numericProdId = body.prodId !== undefined ? Number(body.prodId) : undefined;
      const targetDesktop = body.desktopCode || body.desktopId;

      try {
        const msg = await manager.manualRedeem(
          acc.name,
          Number.isFinite(numericProdId) ? numericProdId : undefined,
          body.costPoints,
          body.prodType,
          targetDesktop,
        );
        return sendSuccess(reply, null, msg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, msg);
      }
    },
  );

  // 4. 获取积分商城可兑换商品目录
  fastify.get('/api/rewards', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    try {
      const data = await manager.getAvailableRewards();
      return sendSuccess(reply, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendError(reply, msg);
    }
  });
};
