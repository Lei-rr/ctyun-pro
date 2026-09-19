import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { ProfileManager } from '../core/profile-manager.js';
import type { AuthContext } from './auth.js';
import { sendSuccess } from '../infra/reply.js';

export const logRoutes: FastifyPluginAsync<{
  manager: ProfileManager;
  authContext: AuthContext;
}> = async (fastify, { manager, authContext }) => {
  const { isValidToken, parseCookieToken } = authContext;

  // 1. SSE 实时日志推流 (带 token 验证，兼容同源 Cookie 鉴权)
  fastify.get('/api/logs/stream', (request: FastifyRequest<{ Querystring: { token?: string } }>, reply) => {
    const cookieToken = parseCookieToken(request.headers?.cookie);
    const token = (request.query?.token as string) || cookieToken;
    if (manager.adminPassword && (!token || !isValidToken(token))) {
      return reply.code(401).send('Unauthorized');
    }

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const recent = manager.getRecentLogs();
    reply.raw.write(`data: ${JSON.stringify({ type: 'init', logs: recent })}\n\n`);

    let closed = false;
    const unsubscribe = manager.subscribeLogs((log) => {
      if (closed || reply.raw.writableEnded) return;
      try {
        if (log.message === '__CLEAR__') {
          reply.raw.write(`data: ${JSON.stringify({ type: 'init', logs: [] })}\n\n`);
        } else {
          reply.raw.write(`data: ${JSON.stringify({ type: 'log', log })}\n\n`);
        }
      } catch {}
    });

    request.raw.on('close', () => {
      closed = true;
      unsubscribe();
    });
  });

  // 2. 获取历史日志快照
  fastify.get('/api/logs', async (_request: FastifyRequest, reply: FastifyReply) => {
    return sendSuccess(reply, manager.getRecentLogs());
  });

  // 3. 清空服务端日志
  fastify.post('/api/logs/clear', async (_request: FastifyRequest, reply: FastifyReply) => {
    manager.clearLogs();
    return sendSuccess(reply, null, '日志已清空');
  });
};
