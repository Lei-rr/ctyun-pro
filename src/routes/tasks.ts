import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { ProfileManager } from '../core/index.js';
import type { AccountConfig } from '../config.js';
import type { AuthContext } from './auth.js';

export const taskRoutes: FastifyPluginAsync<{
  manager: ProfileManager;
  authContext: AuthContext;
}> = async (fastify, { manager, authContext }) => {
  const { verifyAuth } = authContext;

  // 辅助函数：根据 Profile ID 校验并获取有效账号
  const resolveAccount = (id: string, reply: FastifyReply): AccountConfig | null => {
    const acc = manager.getAccount(id);
    if (!acc) {
      reply.code(404).send({ success: false, msg: 'Profile 未找到' });
      return null;
    }
    return acc;
  };

  // 查询任务进度和积分信息
  fastify.get(
    '/api/profiles/:id/tasks',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      const data = await manager.getPointsAndTasks(acc.name);
      return { success: true, data };
    },
  );

  // 兼容前端 /api/profiles/:id/points 路由
  fastify.get(
    '/api/profiles/:id/points',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      const data = await manager.getPointsAndTasks(acc.name);
      return { success: true, data };
    },
  );

  // 手动执行所有日常任务
  fastify.post(
    '/api/profiles/:id/tasks/run',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      const msg = await manager.manualRunTasks(acc.name);
      return { success: true, msg };
    },
  );

  // 手动执行每日签到打卡
  fastify.post(
    '/api/profiles/:id/tasks/sign',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      const msg = await manager.manualSignIn(acc.name);
      return { success: true, msg };
    },
  );

  // 手动执行 AI 对话互动任务
  fastify.post(
    '/api/profiles/:id/tasks/chat',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      const msg = await manager.manualAiChat(acc.name);
      return { success: true, msg };
    },
  );

  // 手动执行积分兑换
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

      const msg = await manager.manualRedeem(
        acc.name,
        Number.isFinite(numericProdId) ? numericProdId : undefined,
        body.costPoints,
        body.prodType,
        targetDesktop,
      );
      return { success: true, msg };
    },
  );

  // 获取积分商城可兑换商品目录
  fastify.get('/api/rewards', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    const data = await manager.getAvailableRewards();
    return { success: true, data };
  });
};
