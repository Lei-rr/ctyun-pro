import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { ProfileManager } from '../core/index.js';
import type { AuthContext } from './auth.js';
import type { PowerActionOptions } from '../types/index.js';
import { sendSuccess, sendError } from '../common/response.js';

export const desktopRoutes: FastifyPluginAsync<{
  manager: ProfileManager;
  authContext: AuthContext;
}> = async (fastify, { manager, authContext }) => {
  const { verifyAuth } = authContext;

  // 云电脑列表 (包含实时运行状态、剩余使用时间等)
  fastify.get('/api/desktops', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    const allDesktops: Array<Record<string, unknown>> = [];
    const accounts = manager.getAccountsSummary();
    for (const acc of accounts) {
      if (acc.desktops && acc.desktops.length > 0) {
        for (const d of acc.desktops) {
          allDesktops.push({
            ...d,
            accountName: acc.name,
            accountUser: acc.user,
          });
        }
      }
    }
    return sendSuccess(reply, allDesktops);
  });

  // 获取免密全屏直连视窗的签名 URL
  fastify.get(
    '/api/desktops/:desktopCode/direct-url',
    async (
      request: FastifyRequest<{
        Params: { desktopCode: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const { desktopCode } = request.params;
      try {
        const res = await manager.getDesktopDirectUrlByDesktopCode(desktopCode);
        return sendSuccess(reply, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, msg);
      }
    },
  );

  // 指定 Desktop 电源操作 (开机/关机/重启)
  fastify.post(
    '/api/desktops/:desktopCode/power',
    async (
      request: FastifyRequest<{
        Params: { desktopCode: string };
        Body: PowerActionOptions;
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const { desktopCode } = request.params;
      const body = request.body || {};
      const res = manager.findDesktopByCode(desktopCode);
      if (!res) {
        return sendError(reply, '云电脑未找到', 404);
      }
      let op: 'on' | 'awake' | 'shutdown' | 'reset' | 'force_off' | 'force_reboot' = 'on';
      if (body.action === 'shutdown' || body.action === 'off' || body.action === 'stop') op = 'shutdown';
      else if (body.action === 'force_off') op = 'force_off';
      else if (body.action === 'reset' || body.action === 'reboot' || body.action === 'restart') op = 'reset';
      else if (body.action === 'force_reboot') op = 'force_reboot';
      else if (body.action === 'awake' || body.action === 'wake') op = 'awake';

      try {
        const msg = await manager.operateDesktop(res.accountName, desktopCode, op);
        return sendSuccess(reply, null, msg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(reply, msg);
      }
    },
  );

  // 指定 Desktop 重命名/修改官方昵称操作 (对齐官方 modifyDesktopNickName)
  const handleDesktopRename = async (
    request: FastifyRequest<{
      Params: { desktopCode: string };
      Body: { desktopName?: string; newName?: string; nickName?: string };
    }>,
    reply: FastifyReply,
  ) => {
    if (!verifyAuth(request, reply)) return;
    const { desktopCode } = request.params;
    const body = request.body || {};
    const newName = (body.desktopName || body.newName || body.nickName || '').trim();
    if (!newName) {
      return sendError(reply, '云电脑名称不能为空');
    }
    try {
      await manager.renameDesktop(desktopCode, newName);
      return sendSuccess(reply, null, '修改成功');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendError(reply, msg);
    }
  };

  fastify.post('/api/desktops/:desktopCode/rename', handleDesktopRename);
};
