import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { errorText } from '../infra/http.js';
import type { ProfileManager } from '../manager.js';
import type { AccountConfig } from '../config.js';
import { sendSuccess, sendError } from '../common/response.js';

export const taskRoutes: FastifyPluginAsync<{ manager: ProfileManager }> = async (fastify, { manager }) => {

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
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      try {
        const data = await manager.getPointsAndTasks(acc.name);
        return sendSuccess(reply, data);
      } catch (err) {
        const msg = errorText(err);
        return sendError(reply, msg);
      }
    },
  );

  // 1.1 查询积分收支明细 (对齐官方 getPointDetailList)
  fastify.get(
    '/api/profiles/:id/points/detail',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { pageNum?: string; pageSize?: string; msgType?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      const query = request.query || {};
      try {
        const data = await manager.getPointDetailList(acc.name, {
          pageNum: query.pageNum ? Number(query.pageNum) : 1,
          pageSize: query.pageSize ? Number(query.pageSize) : 10,
          msgType: query.msgType ? Number(query.msgType) : undefined,
        });
        return sendSuccess(reply, data);
      } catch (err) {
        const msg = errorText(err);
        return sendError(reply, msg);
      }
    },
  );

  // 2. 手动执行 AI 对话互动任务
  fastify.post(
    '/api/profiles/:id/tasks/chat',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const acc = resolveAccount(request.params.id, reply);
      if (!acc) return;
      try {
        const msg = await manager.manualAiChat(acc.name);
        return sendSuccess(reply, null, msg);
      } catch (err) {
        const msg = errorText(err);
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
          costPointType?: number;
          count?: number;
          mobilephone?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
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
          {
            costPointType: body.costPointType,
            count: body.count,
            mobilephone: body.mobilephone,
          },
        );
        return sendSuccess(reply, null, msg);
      } catch (err) {
        const msg = errorText(err);
        return sendError(reply, msg);
      }
    },
  );

  // 4. 获取积分商城可兑换商品目录 (纯内存缓存，refresh=1 时强制向官方刷新)
  fastify.get(
    '/api/rewards',
    async (
      request: FastifyRequest<{ Querystring: { profileId?: string; refresh?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const query = request.query || {};
        const acc = query.profileId ? manager.getAccount(query.profileId) : undefined;
        const forceRefresh = query.refresh === '1' || query.refresh === 'true';
        const data = await manager.getAvailableRewards(acc?.name, forceRefresh);
        return sendSuccess(reply, data);
      } catch (err) {
        const msg = errorText(err);
        return sendError(reply, msg);
      }
    },
  );
};
