import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { errorText } from '../infra/http.js';
import type { ProfileManager } from '../core/profile-manager.js';
import type { AccountConfig } from '../config.js';
import { sendSuccess, sendError } from '../infra/reply.js';
import { randomUUID } from 'node:crypto';

/** 异步兑换任务状态 */
interface RedeemTaskState {
  id: string;
  accountName: string;
  status: 'running' | 'success' | 'error';
  message: string;
  startedAt: number;
  finishedAt?: number;
}

// 兑换为长耗时流程(升配类需等订单生效并重启云电脑)，改为后台执行 + taskId 轮询
const redeemTasks = new Map<string, RedeemTaskState>();
const REDEEM_TASK_KEEP_MS = 10 * 60 * 1000;
const REDEEM_TASK_MAX = 50;

/** 清理已完成的过期任务，超上限时淘汰最旧记录，避免内存无界增长 */
function pruneRedeemTasks(): void {
  const now = Date.now();
  for (const [id, t] of redeemTasks) {
    if (t.finishedAt && now - t.finishedAt > REDEEM_TASK_KEEP_MS) redeemTasks.delete(id);
  }
  if (redeemTasks.size > REDEEM_TASK_MAX) {
    const oldest = [...redeemTasks.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const t of oldest.slice(0, redeemTasks.size - REDEEM_TASK_MAX)) redeemTasks.delete(t.id);
  }
}

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

      // 同账号并发兑换会重复下单扣积分，服务端直接拒绝
      for (const t of redeemTasks.values()) {
        if (t.accountName === acc.name && t.status === 'running') {
          return sendError(reply, '该账号已有兑换任务正在执行，请等待完成');
        }
      }

      pruneRedeemTasks();
      const taskId = randomUUID();
      const task: RedeemTaskState = {
        id: taskId,
        accountName: acc.name,
        status: 'running',
        message: '兑换任务已提交，正在处理',
        startedAt: Date.now(),
      };
      redeemTasks.set(taskId, task);

      // 兑换全程可达数分钟，放后台执行，HTTP 立即返回 taskId 供前端轮询
      void (async () => {
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
          task.status = 'success';
          task.message = msg || '兑换完成';
        } catch (err) {
          task.status = 'error';
          task.message = errorText(err);
        } finally {
          task.finishedAt = Date.now();
        }
      })();

      return sendSuccess(reply, { taskId, status: task.status }, '兑换任务已提交，正在后台执行');
    },
  );

  // 3.1 查询兑换任务状态 (前端轮询终态)
  fastify.get(
    '/api/tasks/redeem/:taskId',
    async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
      const t = redeemTasks.get(request.params.taskId);
      if (!t) return sendError(reply, '兑换任务不存在或已过期', 404);
      return sendSuccess(reply, {
        taskId: t.id,
        status: t.status,
        message: t.message,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt ?? null,
      });
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
        const data = await manager.getAvailableRewards(acc?.name);
        return sendSuccess(reply, data);
      } catch (err) {
        const msg = errorText(err);
        return sendError(reply, msg);
      }
    },
  );
};
