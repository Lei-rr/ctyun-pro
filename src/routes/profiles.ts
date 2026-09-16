import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import QRCode from 'qrcode';
import type { ProfileManager } from '../core/index.js';
import type { AuthContext } from './auth.js';
import type { ChallengeData } from '../core/client.js';
import type { TaskConfig, RedeemConfig } from '../config.js';
import { getRandomScheduleTime, DEFAULT_REDEEM_CONFIG } from '../config.js';
import { sendSuccess, sendError } from '../common/response.js';

export const profileRoutes: FastifyPluginAsync<{
  manager: ProfileManager;
  authContext: AuthContext;
  smsSessionCache: Map<string, { captchaKey?: string; smsKey?: string; expireAt?: number }>;
}> = async (fastify, { manager, authContext, smsSessionCache }) => {
  const { verifyAuth } = authContext;

  // 1. Profiles 列表 (所有身份档案及所属云实例快照)
  fastify.get('/api/profiles', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    return sendSuccess(reply, manager.getAccountsSummary());
  });

  // 2. 新建 Profile 档案
  fastify.post(
    '/api/profiles',
    async (
      request: FastifyRequest<{
        Body: {
          name?: string;
          user?: string;
          autoStart?: boolean;
          taskConfig?: Partial<TaskConfig>;
          redeemConfig?: Partial<RedeemConfig>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const body = request.body || {};
      const name = (body.name || body.user || '').trim();
      const user = (body.user || body.name || '').trim();
      if (!name || !user) {
        return sendError(reply, '档案名称与手机号不能为空');
      }
      await manager.addOrUpdateAccount({
        name,
        user,
        autoStart: body.autoStart !== false,
        taskConfig: {
          enabled: body.taskConfig?.enabled ?? true,
          scheduleTime: body.taskConfig?.scheduleTime || getRandomScheduleTime(),
          aiChat: body.taskConfig?.aiChat ?? true,
        },
        redeemConfig: {
          ...DEFAULT_REDEEM_CONFIG,
          ...(body.redeemConfig || {}),
          enabled: body.redeemConfig?.enabled ?? true,
        },
      });
      manager.addLog('info', `[${name}] 档案已创建`);
      return sendSuccess(reply, manager.getAccountState(name), 'Profile 创建成功');
    },
  );

  // 3. 生成扫码登录二维码
  fastify.post(
    '/api/profiles/qrcode/create',
    async (
      request: FastifyRequest<{
        Body: {
          name?: string;
          accountName?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const body = request.body || {};
      const accountName =
        (body.name || body.accountName || '').trim() || `user_${Date.now().toString().slice(-4)}`;
      const client = manager.getClient(accountName);
      const { qrCodeId, qrUrl } = await client.genQrCode();
      const qrImage = await QRCode.toDataURL(qrUrl, {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      return sendSuccess(reply, { accountName, qrCodeId, qrUrl, qrImage });
    },
  );

  // 4. 轮询扫码状态并自动完成登录授权
  fastify.get(
    '/api/profiles/qrcode/status',
    async (
      request: FastifyRequest<{
        Querystring: {
          qrCodeId?: string;
          accountName?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const query = request.query || {};
      if (!query.qrCodeId) {
        return sendError(reply, '缺少 qrCodeId 参数');
      }
      const accountName = (query.accountName || '').trim() || 'default';
      const client = manager.getClient(accountName);
      const statusData = await client.getQrCodeStatus(query.qrCodeId);
      if (statusData.codeStatus === 'authorize' && statusData.loginToken) {
        manager.addLog('info', `[${accountName}] 扫码授权成功，正在换取登录凭证...`);
        const loginInfo = await client.loginByToken(statusData.loginToken);
        const finalUser = loginInfo.mobilephone || loginInfo.userName || loginInfo.userAccount || accountName;
        const finalAccountName = (query.accountName || '').trim() || finalUser;
        await manager.addOrUpdateAccount({
          name: finalAccountName,
          user: finalUser,
          deviceCode: client.getDeviceCode(),
          loginInfo,
          autoStart: true,
        });
        manager.addLog('success', `[${finalAccountName}] 扫码登录成功！已就绪并同步积分与保活`);
        manager.startAccount(finalAccountName).catch((e) => {
          manager.addLog('warn', `[${finalAccountName}] 启动保活提示: ${e.message}`);
        });
        return sendSuccess(reply, {
          codeStatus: 'authorize',
          accountName: finalAccountName,
          loginInfo: manager.sanitizeLoginInfo(loginInfo),
        }, '登录成功');
      }
      return sendSuccess(reply, { codeStatus: statusData.codeStatus });
    },
  );

  // 5. 单个 Profile 详情
  fastify.get(
    '/api/profiles/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const acc = manager.getAccount(id);
      const state = manager.getAccountState(id);
      if (!acc && !state) {
        return sendError(reply, 'Profile 不存在', 404);
      }
      return sendSuccess(reply, state || manager.sanitizeAccount(acc));
    },
  );

  // 6. 删除 Profile
  fastify.delete(
    '/api/profiles/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const acc = manager.getAccount(id);
      if (!acc) {
        return sendError(reply, 'Profile 不存在', 404);
      }
      manager.removeAccount(acc.name);
      if (acc.name) {
        smsSessionCache.delete(acc.name);
      }
      if (acc.id) {
        smsSessionCache.delete(acc.id);
      }
      return sendSuccess(reply, null, 'Profile 已成功注销');
    },
  );

  // 7. 重命名 Profile 备注名
  const handleProfileRename = async (
    request: FastifyRequest<{
      Params: { id: string };
      Body: { name?: string; newName?: string; oldName?: string };
    }>,
    reply: FastifyReply,
  ) => {
    if (!verifyAuth(request, reply)) return;
    const { id } = request.params;
    const body = request.body || {};
    const targetName = (body.newName || body.name || '').trim();
    if (!targetName) {
      return sendError(reply, '名称不能为空');
    }
    const acc = manager.getAccount(id);
    if (!acc) {
      return sendError(reply, 'Profile 不存在', 404);
    }
    manager.updateAccountName(acc.name, targetName);
    return sendSuccess(reply, null, '重命名成功');
  };

  fastify.post('/api/profiles/:id/rename', handleProfileRename);

  // 8. 触发指定 Profile 的实例列表同步与本地落盘
  fastify.post(
    '/api/profiles/:id/sync',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const acc = manager.getAccount(id);
      if (!acc) {
        return sendError(reply, 'Profile 不存在', 404);
      }
      await manager.reloadDesktops(acc.name);
      return sendSuccess(reply, manager.getAccountState(acc.name));
    },
  );

  // 9. 获取图形验证码与 challenge
  fastify.get(
    '/api/profiles/:id/captcha',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { user?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const query = request.query || {};
      const acc = manager.getAccount(id);
      const user = query.user || acc?.user || id;
      const client = manager.getClient(acc?.name || id);
      const challenge = await client.getChallengeData();
      const imgBuffer = await client.getLoginCaptcha(user);
      return sendSuccess(reply, {
        image: `data:image/jpeg;base64,${imgBuffer.toString('base64')}`,
        challenge: {
          challengeId: challenge.challengeId,
          challengeCode: challenge.challengeCode,
        },
      });
    },
  );

  // 10. 密码登录
  fastify.post(
    '/api/profiles/:id/login',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          user?: string;
          name?: string;
          password?: string;
          captchaCode?: string;
          challenge?: { challengeId?: string; challengeCode?: string };
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const body = request.body || {};
      const acc = manager.getAccount(id);
      const user = body.user || acc?.user || id;
      const name = acc?.name || body.name || id;
      const client = manager.getClient(name);

      let challenge: ChallengeData;
      if (body.challenge && body.challenge.challengeId && body.challenge.challengeCode) {
        challenge = {
          challengeId: body.challenge.challengeId.trim(),
          challengeCode: body.challenge.challengeCode.trim(),
        };
      } else {
        try {
          challenge = await client.getChallengeData();
        } catch {
          return sendError(reply, '请先刷新验证码');
        }
      }

      try {
        manager.addLog('info', `[${name}] 正在验证登录...`);
        const loginInfo = await client.login(user, body.password || '', challenge, (body.captchaCode || '').trim());
        await manager.addOrUpdateAccount({
          name,
          user,
          deviceCode: client.getDeviceCode(),
          loginInfo,
          autoStart: true,
        });
        if (!loginInfo.bondedDevice) {
          manager.addLog('warn', `[${name}] 设备未绑定，需要短信验证码确认`);
          return sendSuccess(reply, { needSms: true }, '登录成功，但当前设备未绑定，需要输入短信验证码');
        }
        manager.addLog('success', `[${name}] 登录成功！正在启动云电脑保活...`);
        manager.startAccount(name).catch((e) => manager.addLog('error', `[${name}] 启动保活失败: ${e.message}`));
        return sendSuccess(reply, manager.getAccountState(name), '登录成功并已启动保活');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        manager.addLog('error', `[${name}] 登录验证失败: ${msg}`);
        return sendError(reply, msg);
      }
    },
  );

  // 11. 短信图形验证码
  fastify.get(
    '/api/profiles/:id/sms-captcha',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const acc = manager.getAccount(id);
      const name = acc?.name || id;
      const client = manager.getClient(name);
      const { image, captchaKey } = await client.getSmsCodeCaptcha();
      if (captchaKey) {
        const cur = smsSessionCache.get(name) || { expireAt: 0 };
        cur.captchaKey = captchaKey;
        cur.expireAt = Date.now() + 10 * 60 * 1000;
        smsSessionCache.set(name, cur);
      }
      reply.type('image/jpeg').send(image);
    },
  );

  // 12. 发送短信验证码
  fastify.post(
    '/api/profiles/:id/send-sms',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { user?: string; captchaCode?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const body = request.body || {};
      const acc = manager.getAccount(id);
      const name = acc?.name || id;
      const user = body.user || acc?.user;
      if (!user || !body.captchaCode) {
        return sendError(reply, '参数不完整');
      }
      const client = manager.getClient(name);
      const cachedKey = smsSessionCache.get(name)?.captchaKey || '';
      try {
        const { smsKey } = await client.sendSmsCode(user, body.captchaCode.trim(), cachedKey);
        if (smsKey) {
          const cur = smsSessionCache.get(name) || {};
          cur.smsKey = smsKey;
          cur.expireAt = Date.now() + 10 * 60 * 1000;
          smsSessionCache.set(name, cur);
        }
        manager.addLog('info', `[${name}] 短信验证码已发送至手机号 ${user}`);
        return sendSuccess(reply, null, '验证码已发送');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        manager.addLog('error', `[${name}] 发送短信失败: ${msg}`);
        return sendError(reply, msg);
      }
    },
  );

  // 13. 二次校验设备绑定
  fastify.post(
    '/api/profiles/:id/bind-device',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { smsCode?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const body = request.body || {};
      const acc = manager.getAccount(id);
      const name = acc?.name || id;
      if (!body.smsCode) {
        return sendError(reply, '请填写短信验证码');
      }
      const client = manager.getClient(name);
      const cachedSmsKey = smsSessionCache.get(name)?.smsKey || '';
      try {
        await client.bindDevice(body.smsCode.trim(), cachedSmsKey);
        smsSessionCache.delete(name);
        if (acc && client.loginInfo) {
          acc.loginInfo = client.loginInfo;
        }
        manager.saveToDisk();
        manager.addLog('success', `[${name}] 设备绑定成功！正在启动保活...`);
        manager.startAccount(name).catch((e) => manager.addLog('error', `[${name}] 启动保活失败: ${e.message}`));
        return sendSuccess(reply, null, '绑定成功并已启动保活');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        manager.addLog('error', `[${name}] 设备绑定失败: ${msg}`);
        return sendError(reply, msg);
      }
    },
  );

  // 14. 策略配置更新
  fastify.post(
    '/api/profiles/:id/policy',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          taskConfig?: Partial<TaskConfig>;
          redeemConfig?: Partial<RedeemConfig>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const body = request.body || {};
      const acc = manager.getAccount(id);
      if (!acc) return sendError(reply, 'Profile 未找到', 404);
      const currentTaskConfig = acc.taskConfig || {
        enabled: true,
        scheduleTime: getRandomScheduleTime(),
        aiChat: true,
      };
      const currentRedeemConfig = acc.redeemConfig || { ...DEFAULT_REDEEM_CONFIG };

      await manager.addOrUpdateAccount({
        ...acc,
        taskConfig: body.taskConfig !== undefined ? { ...currentTaskConfig, ...body.taskConfig } : acc.taskConfig,
        redeemConfig: body.redeemConfig !== undefined ? { ...currentRedeemConfig, ...body.redeemConfig } : acc.redeemConfig,
      });
      manager.addLog('info', `[${acc.name}] 策略配置已更新并落盘`);
      return sendSuccess(reply, manager.getAccountState(acc.name));
    },
  );

  // 15. 保活控制：启动 / 停止
  fastify.post(
    '/api/profiles/:id/start',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const acc = manager.getAccount(id);
      if (!acc) return sendError(reply, 'Profile 未找到', 404);
      await manager.startAccount(acc.name);
      return sendSuccess(reply, null, `账号 [${acc.name}] 保活已启动`);
    },
  );

  fastify.post(
    '/api/profiles/:id/stop',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAuth(request, reply)) return;
      const { id } = request.params;
      const acc = manager.getAccount(id);
      if (!acc) return sendError(reply, 'Profile 未找到', 404);
      manager.stopAccount(acc.name);
      return sendSuccess(reply, null, `账号 [${acc.name}] 保活已停止`);
    },
  );
};
