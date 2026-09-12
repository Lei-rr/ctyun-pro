import dns from 'node:dns';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// 强制全局 IPv4 优先，防止双栈/容器内 IPv6 无路由造成网络黑洞或连接挂起
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { Config, DEFAULT_REDEEM_CONFIG } from './config.js';
import { ProfileManager } from './core/index.js';
import { DesktopSessionArbiter } from './modules/arbiter/index.js';
import { StrategyService } from './modules/strategy/index.js';
import { CtYunClient, type ChallengeData } from './core/client.js';
import { safeWriteFileSync, sendWebhookNotification } from './core/utils.js';
import { EMBEDDED_WEB_FILES } from './embedded-web.js';
import { registerDesktopProxyRoutes } from './core/desktop-proxy.js';

export async function createServer() {
  const fastify = Fastify({
    logger: false,
  });

  // 兼容前端 Content-Type: application/json 但未传 body 导致的 400 错误
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      done(null, {});
      return;
    }
    try {
      const json = JSON.parse(body as string);
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // 兼容代理通道和其他 POST 请求（如 application/x-www-form-urlencoded、text/plain、二进制等）
  // 避免 Fastify 报 415 (FST_ERR_CTP_INVALID_MEDIA_TYPE)
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  const allowedOriginEnv = process.env.CORS_ORIGIN;
  await fastify.register(cors, {
    origin: (origin, cb) => {
      // 1. 同源请求（无 Origin 请求头，如浏览器直接访问、服务端内部调用）直接放行
      if (!origin) return cb(null, true);

      // 2. 若通过环境变量显式配置了 CORS_ORIGIN 白名单，严格执行白名单拦截
      if (allowedOriginEnv) {
        if (allowedOriginEnv === '*') return cb(null, true);
        const list = allowedOriginEnv.split(',').map((s) => s.trim());
        return cb(null, list.includes(origin));
      }

      // 3. 本地开发与标准私有局域网网段默认放行
      const isLocalOrLan = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);
      if (isLocalOrLan) {
        return cb(null, true);
      }

      // 4. 未显式配置且非本地时默认放行（开箱即用），但可通过 CORS_ORIGIN 随时收紧
      return cb(null, true);
    },
    credentials: true,
  });

  const manager = new ProfileManager();
  
  // 持久化 session 文件，避免容器重启后丢失已有登录状态
  const sessionFilePath = path.join(Config.dataDir, '.sessions.json');
  const sessions = new Set<string>();
  try {
    if (fs.existsSync(sessionFilePath)) {
      const saved = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
      if (Array.isArray(saved)) {
        for (const t of saved) {
          if (typeof t === 'string') sessions.add(t);
        }
      }
    }
  } catch {}

  const saveSessions = () => {
    try {
      safeWriteFileSync(sessionFilePath, JSON.stringify(Array.from(sessions)));
    } catch {}
  };

  const isValidToken = (token?: string): boolean => {
    if (!manager.adminPassword) return true;
    if (!token) return false;
    if (sessions.has(token)) return true;
    // 兼容 HMAC 签名 token (即使镜像更新或 .sessions.json 丢失，只要密码未改且在 30 天内仍有效)
    try {
      const parts = token.split('.');
      if (parts.length === 2) {
        const [tsStr, sig] = parts;
        const ts = Number(tsStr);
        if (!isNaN(ts) && Date.now() - ts < 30 * 24 * 3600 * 1000 && Date.now() >= ts - 60000) {
          const expected = crypto
            .createHmac('sha256', manager.adminPassword)
            .update(tsStr)
            .digest('hex');
          if (sig === expected) {
            sessions.add(token);
            saveSessions();
            return true;
          }
        }
      }
    } catch {}
    return false;
  };

  // 临时暂存各账号的登录 challenge 与短信流程 key
  const challengeCache = new Map<string, ChallengeData>();
  const smsSessionCache = new Map<string, { captchaKey?: string; smsKey?: string }>();

  // 校验中间件 (如果设置了 adminPassword)
  const parseCookieToken = (cookieHeader?: string): string => {
    if (!cookieHeader) return '';
    const match = cookieHeader.match(/(?:^|;\s*)ctyun_admin_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  };

  const verifyAuth = (request: any, reply: any): boolean => {
    if (!manager.adminPassword) {
      return true;
    }
    const token =
      request.headers['x-admin-token'] ||
      (request.query && request.query.token) ||
      (request.headers.authorization ? request.headers.authorization.replace(/^Bearer\s+/i, '') : '') ||
      parseCookieToken(request.headers.cookie);
    if (!isValidToken(token as string)) {
      reply.code(401).send({ success: false, msg: '未授权或登录已过期，请重新登录' });
      return false;
    }
    return true;
  };

  // 0. 系统鉴权状态与登录接口
  fastify.get('/api/auth/status', async (request: any) => {
    const needAuth = Boolean(manager.adminPassword);
    let authenticated = !needAuth;
    if (needAuth) {
      const token =
        request.headers['x-admin-token'] ||
        (request.headers.authorization ? request.headers.authorization.replace(/^Bearer\s+/i, '') : '');
      authenticated = isValidToken(token as string);
    }
    return {
      success: true,
      data: {
        needAuth,
        authenticated,
      },
    };
  });

  fastify.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { password?: string };
    if (!manager.adminPassword) {
      return { success: true, token: 'no-auth' };
    }
    if (!body || body.password !== manager.adminPassword) {
      return reply.code(401).send({ success: false, msg: '管理密码错误' });
    }
    const ts = Date.now().toString();
    const sig = crypto
      .createHmac('sha256', manager.adminPassword)
      .update(ts)
      .digest('hex');
    const token = `${ts}.${sig}`;
    sessions.add(token);
    saveSessions();
    reply.header('Set-Cookie', `ctyun_admin_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
    return { success: true, token };
  });

  // 0.2 注销登录 (作废服务端 Token 并清除客户端 Cookie)
  fastify.post('/api/auth/logout', async (request, reply) => {
    const token =
      (request.headers['x-admin-token'] as string) ||
      (request.headers.authorization ? (request.headers.authorization as string).replace(/^Bearer\s+/i, '') : '') ||
      parseCookieToken(request.headers.cookie);
    if (token && sessions.has(token)) {
      sessions.delete(token);
      saveSessions();
    }
    reply.header(
      'Set-Cookie',
      'ctyun_admin_token=; Path=/; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
    return { success: true, msg: '已安全退出登录' };
  });

  fastify.post('/api/auth/password', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { newPassword?: string };
    manager.adminPassword = body.newPassword ? body.newPassword.trim() : '';
    manager.saveToDisk();
    sessions.clear();
    saveSessions();
    manager.addLog('info', manager.adminPassword ? '已更新控制台管理密码' : '已取消控制台管理密码');
    return { success: true };
  });

  // 1. 获取系统状态 & 账号列表
  fastify.get('/api/status', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    return {
      success: true,
      data: {
        needAuth: Boolean(manager.adminPassword),
        webhookUrl: manager.webhookUrl,
        keepAliveSeconds: manager.keepAliveSeconds,
        accounts: manager.getAccountsSummary(),
        leases: DesktopSessionArbiter.getInstance().getActiveLeases(),
      },
    };
  });

  // 1.0 查询全局桌面租约状态 (仲裁器)
  fastify.get('/api/arbiter/leases', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    return {
      success: true,
      data: DesktopSessionArbiter.getInstance().getActiveLeases(),
    };
  });

  // 1.1 更新系统全局配置 (直接回写 data/config.json)
  fastify.post('/api/config/system', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as {
      keepAliveSeconds?: number;
      adminPassword?: string;
      webhookUrl?: string;
    };
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
  });

  // 1.2 测试 Webhook 推送连通性
  fastify.post('/api/config/webhook/test', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = (request.body as any) || {};
    const targetUrl = (body.webhookUrl || manager.webhookUrl || '').trim();
    if (!targetUrl) {
      return reply.send({ success: false, msg: '请先填写 Webhook 推送地址' });
    }

    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const success = await sendWebhookNotification(
      targetUrl,
      'CTYUN-PRO - Webhook 通知测试',
      `恭喜！您的 Webhook 消息通知配置成功！\n\n• 测试结果: 成功连通\n• 发送时间: ${nowStr}\n• 监控范围: 智能挂机达标、Token过期告警、每日运行战报已接入。`,
    );

    if (success) {
      return reply.send({ success: true, msg: '测试消息已成功送达，请前往对应渠道查收！' });
    } else {
      return reply.send({
        success: false,
        msg: '测试推送失败，请检查 Webhook 地址格式或宿主机网络连通性',
      });
    }
  });

  // 2.3 修改保活心跳重连周期
  fastify.post('/api/config/keepalive', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { seconds: number };
    if (!body || typeof body.seconds !== 'number' || body.seconds < 10) {
      return reply.code(400).send({ success: false, msg: '保活周期必须为数字且不小于 10 秒' });
    }
    manager.keepAliveSeconds = body.seconds;
    manager.saveToDisk();
    manager.addLog('info', `保活重连周期已调整为 ${body.seconds} 秒`);
    return { success: true };
  });

  // ==========================================
  // 标准 RESTful 优雅 API 体系 (profiles & desktops)
  // 彻底废除历史老旧兼容垫片 (/api/account/*, /api/instances/*)
  // ==========================================

  // Profiles 列表 (所有身份档案及所属云实例快照)
  fastify.get('/api/profiles', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    return { success: true, data: manager.getAccountsSummary() };
  });

  // 新建 Profile 档案
  fastify.post('/api/profiles', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = (request.body as any) || {};
    const name = (body.name || body.user || '').trim();
    const user = (body.user || body.name || '').trim();
    if (!name || !user) {
      return reply.code(400).send({ success: false, msg: '档案名称与手机号不能为空' });
    }
    await manager.addOrUpdateAccount({
      name,
      user,
      password: body.password || '',
      autoSign: body.autoSign !== false,
      autoStart: body.autoStart !== false,
      taskConfig: body.taskConfig || { enabled: true, scheduleTime: StrategyService.generateRandomSchedule(), autoHang: true, autoAiChat: true },
      redeemConfig: body.redeemConfig || { ...DEFAULT_REDEEM_CONFIG, enabled: true },
    });
    manager.addLog('info', `[${name}] 档案已创建`);
    return { success: true, msg: 'Profile 创建成功', data: manager.getAccountState(name) };
  });

  // 生成扫码登录二维码
  fastify.post('/api/profiles/qrcode/create', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = (request.body as any) || {};
    const accountName = (body.name || body.accountName || '').trim() || `user_${Date.now().toString().slice(-4)}`;
    const client = manager.getClient(accountName);
    try {
      const { qrCodeId, qrUrl } = await client.genQrCode();
      const qrImage = await QRCode.toDataURL(qrUrl, {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      return { success: true, data: { accountName, qrCodeId, qrUrl, qrImage } };
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message || '生成二维码失败' });
    }
  });

  // 轮询扫码状态并自动完成登录授权
  fastify.get('/api/profiles/qrcode/status', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const query = request.query as { qrCodeId?: string; accountName?: string };
    if (!query.qrCodeId) {
      return reply.code(400).send({ success: false, msg: '缺少 qrCodeId 参数' });
    }
    const accountName = (query.accountName || '').trim() || 'default';
    const client = manager.getClient(accountName);
    try {
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
        return {
          success: true,
          codeStatus: 'authorize',
          accountName: finalAccountName,
          loginInfo: manager.sanitizeAccount({ loginInfo }).loginInfo,
          msg: '登录成功',
        };
      }
      return { success: true, codeStatus: statusData.codeStatus };
    } catch (err: any) {
      return reply.send({ success: false, msg: err.message });
    }
  });

  // 单个 Profile 详情
  fastify.get('/api/profiles/:id', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    const state = manager.getAccountState(params.id);
    if (!acc && !state) {
      return reply.code(404).send({ success: false, msg: 'Profile 不存在' });
    }
    return { success: true, data: state || manager.sanitizeAccount(acc) };
  });

  // 删除 Profile
  fastify.delete('/api/profiles/:id', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) {
      return reply.code(404).send({ success: false, msg: 'Profile 不存在' });
    }
    manager.removeAccount(acc.name);
    return { success: true, msg: 'Profile 已成功注销' };
  });

  // 重命名 Profile 备注名
  fastify.post('/api/profiles/:id/rename', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const body = request.body as { name: string };
    if (!body?.name?.trim()) {
      return reply.code(400).send({ success: false, msg: '名称不能为空' });
    }
    const acc = manager.getAccount(params.id);
    if (!acc) {
      return reply.code(404).send({ success: false, msg: 'Profile 不存在' });
    }
    manager.updateAccountName(acc.name, body.name.trim());
    return { success: true, msg: '重命名成功' };
  });

  // 触发指定 Profile 的实例列表同步与本地落盘
  fastify.post('/api/profiles/:id/sync', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) {
      return reply.code(404).send({ success: false, msg: 'Profile 不存在' });
    }
    await manager.reloadDesktops(acc.name);
    return { success: true, data: manager.getAccountState(acc.name) };
  });

  // Profile 密码/短信/扫码登录与验证绑定
  fastify.get('/api/profiles/:id/captcha', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    const user = acc?.user || params.id;
    const client = manager.getClient(acc?.name || params.id);
    try {
      const challenge = await client.getChallengeData();
      challengeCache.set(acc?.name || params.id, challenge);
      challengeCache.set(user, challenge);
      challengeCache.set('__latest__', challenge);
      const imgBuffer = await client.getLoginCaptcha(user);
      return { success: true, data: { image: `data:image/jpeg;base64,${imgBuffer.toString('base64')}` } };
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/login', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const body = (request.body as any) || {};
    const acc = manager.getAccount(params.id);
    const user = body.user || acc?.user || params.id;
    const name = acc?.name || body.name || params.id;
    const client = manager.getClient(name);
    let challenge = challengeCache.get(name) || challengeCache.get(user) || challengeCache.get('__latest__');
    if (!challenge) {
      try {
        challenge = await client.getChallengeData();
        challengeCache.set(name, challenge);
      } catch {
        return reply.code(400).send({ success: false, msg: '请先刷新验证码' });
      }
    }
    try {
      manager.addLog('info', `[${name}] 正在验证登录...`);
      const loginInfo = await client.login(user, body.password || '', challenge, (body.captchaCode || '').trim());
      await manager.addOrUpdateAccount({
        name,
        user,
        password: body.password || '',
        deviceCode: client.getDeviceCode(),
        loginInfo,
        autoStart: true,
      });
      if (!loginInfo.bondedDevice) {
        manager.addLog('warn', `[${name}] 设备未绑定，需要短信验证码确认`);
        return { success: true, needSms: true, msg: '登录成功，但当前设备未绑���，需要输入短信验证码' };
      }
      manager.addLog('success', `[${name}] 登录成功！正在启动云电脑保活...`);
      manager.startAccount(name).catch((e) => manager.addLog('error', `[${name}] 启动保活失败: ${e.message}`));
      return { success: true, needSms: false, msg: '登录成功并已启动保活', data: manager.getAccountState(name) };
    } catch (err: any) {
      manager.addLog('error', `[${name}] 登录失败: ${err.message}`);
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.get('/api/profiles/:id/sms-captcha', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    const name = acc?.name || params.id;
    const client = manager.getClient(name);
    try {
      const { image, captchaKey } = await client.getSmsCodeCaptcha();
      if (captchaKey) {
        const cur = smsSessionCache.get(name) || {};
        cur.captchaKey = captchaKey;
        smsSessionCache.set(name, cur);
      }
      reply.type('image/jpeg').send(image);
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/send-sms', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const body = (request.body as any) || {};
    const acc = manager.getAccount(params.id);
    const name = acc?.name || params.id;
    const user = body.user || acc?.user;
    if (!user || !body.captchaCode) {
      return reply.code(400).send({ success: false, msg: '参数不完整' });
    }
    const client = manager.getClient(name);
    const cachedKey = smsSessionCache.get(name)?.captchaKey || '';
    try {
      const { smsKey } = await client.sendSmsCode(user, body.captchaCode.trim(), cachedKey);
      if (smsKey) {
        const cur = smsSessionCache.get(name) || {};
        cur.smsKey = smsKey;
        smsSessionCache.set(name, cur);
      }
      manager.addLog('info', `[${name}] 短信验证码已发送至手机号 ${user}`);
      return { success: true };
    } catch (err: any) {
      manager.addLog('error', `[${name}] 发送短信失败: ${err.message}`);
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/bind-device', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const body = (request.body as any) || {};
    const acc = manager.getAccount(params.id);
    const name = acc?.name || params.id;
    if (!body.smsCode) {
      return reply.code(400).send({ success: false, msg: '请填写短信验证码' });
    }
    const client = manager.getClient(name);
    const cachedSmsKey = smsSessionCache.get(name)?.smsKey || '';
    try {
      await client.bindDevice(body.smsCode.trim(), cachedSmsKey);
      if (acc && client.loginInfo) {
        acc.loginInfo = client.loginInfo;
      }
      manager.saveToDisk();
      manager.addLog('success', `[${name}] 设备绑定成功！正在启动保活...`);
      manager.startAccount(name).catch((e) => manager.addLog('error', `[${name}] 启动保活失败: ${e.message}`));
      return { success: true, msg: '绑定成功并已启动保活' };
    } catch (err: any) {
      manager.addLog('error', `[${name}] 设备绑定失败: ${err.message}`);
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // Profile 策略配置与自动化日常任务执行
  fastify.get('/api/profiles/:id/points', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      const data = await manager.getPointsAndTasks(acc.name);
      return { success: true, data };
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/policy', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const body = (request.body as any) || {};
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    await manager.addOrUpdateAccount({
      ...acc,
      autoSign: body.autoSign !== undefined ? body.autoSign : (body.taskConfig?.enabled ?? acc.autoSign),
      taskConfig: body.taskConfig !== undefined ? body.taskConfig : acc.taskConfig,
      redeemConfig: body.redeemConfig !== undefined ? body.redeemConfig : acc.redeemConfig,
    });
    manager.addLog('info', `[${acc.name}] 策略配置已更新并落盘`);
    return { success: true, data: manager.getAccountState(acc.name) };
  });

  fastify.post('/api/profiles/:id/tasks/run', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      const msg = await manager.manualRunTasks(acc.name);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/tasks/sign', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      const msg = await manager.manualSignIn(acc.name);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/start', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      await manager.startAccount(acc.name);
      return { success: true, msg: `账号 [${acc.name}] 保活已启动` };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/stop', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      manager.stopAccount(acc.name);
      return { success: true, msg: `账号 [${acc.name}] 保活已停止` };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/tasks/login', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      const msg = await manager.manualActivateDesktop(acc.name);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/tasks/chat', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      const msg = await manager.manualAiChat(acc.name);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/tasks/hang/start', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      const msg = await manager.manualHang(acc.name);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/tasks/hang/stop', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      await manager.stopHang(acc.name);
      return { success: true, msg: '已成功中止挂机任务，并恢复保活长连接' };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  fastify.post('/api/profiles/:id/tasks/redeem', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { id: string };
    const body = (request.body as any) || {};
    const acc = manager.getAccount(params.id);
    if (!acc) return reply.code(404).send({ success: false, msg: 'Profile 未找到' });
    try {
      const msg = await manager.manualRedeem(acc.name, body.prodId, body.costPoints, body.prodType, body.desktopId);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 获取商城可兑换商品
  fastify.get('/api/rewards', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const query = (request.query as any) || {};
    try {
      const data = await manager.getAvailableRewards(query.profileId, query.refresh === '1' || query.refresh === 'true');
      return { success: true, data };
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message });
    }
  });

  // ==========================================
  // 标准 RESTful 体系: Desktops (一等公民顶级资源)
  // ==========================================

  // 全局 Desktops 汇总列表 (秒级直读本地缓存与保活心跳)
  fastify.get('/api/desktops', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    return { success: true, data: manager.getAllInstancesSummary() };
  });

  // 全局强制同步刷新全量 Desktops
  fastify.post('/api/desktops/sync', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    for (const name of manager.getAllAccounts().keys()) {
      await manager.reloadDesktops(name).catch(() => {});
    }
    return { success: true, data: manager.getAllInstancesSummary() };
  });

  // 指定 Desktop 详情
  fastify.get('/api/desktops/:desktopCode', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    const params = request.params as { desktopCode: string };
    const instances = manager.getAllInstancesSummary();
    const inst = instances.find(i => i.desktopCode === params.desktopCode);
    if (!inst) {
      return reply.code(404).send({ success: false, msg: '云电脑未找到' });
    }
    return { success: true, data: inst };
  });

  // 指定 Desktop 免密直接访问官方 Web 桌面（同源直连地址生成）
  fastify.get('/api/desktops/:desktopCode/direct-url', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    try {
      const params = request.params as { desktopCode: string };
      const res = await manager.getDesktopDirectUrlByDesktopCode(params.desktopCode);
      return { success: true, data: res };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 指定 Desktop 电源操作 (开机/关机/重启)
  fastify.post('/api/desktops/:desktopCode/power', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    try {
      const params = request.params as { desktopCode: string };
      const body = request.body as { action: 'on' | 'off' | 'reboot' | 'start' | 'stop' | 'restart' };
      const instances = manager.getAllInstancesSummary();
      const inst = instances.find(i => i.desktopCode === params.desktopCode);
      if (!inst) {
        return reply.code(404).send({ success: false, msg: '云电脑未找到' });
      }
      let op: 'on' | 'shutdown' | 'reset' = 'on';
      if (body.action === 'off' || body.action === 'stop') op = 'shutdown';
      else if (body.action === 'reboot' || body.action === 'restart') op = 'reset';

      const msg = await manager.operateDesktop(inst.profileName, inst.desktopCode, op);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 9. SSE 实时日志推流 (带 token 验证，兼容同源 Cookie 鉴权)
  fastify.get('/api/logs/stream', (request: any, reply) => {
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

  // 9.1 清空服务端日志
  fastify.post('/api/logs/clear', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    manager.clearLogs();
    return { success: true };
  });

  // 10. 静态页面宿主 (优先读取外部 web/dist，若无则自动使用二进制内嵌的前端资源)
  const webDist = path.resolve(process.cwd(), 'web/dist');
  const hasLocalDist = fs.existsSync(webDist);

  if (hasLocalDist) {
    await fastify.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.code(404).send({ success: false, msg: 'API 接口不存在' });
      } else {
        reply.sendFile('index.html');
      }
    });
  } else if (Object.keys(EMBEDDED_WEB_FILES).length > 0) {
    // 独立二进制模式：从内存中响应内嵌的前端资源
    fastify.setNotFoundHandler((req, reply) => {
      let reqPath = req.url.split('?')[0].replace(/^\/+/, '');
      if (reqPath === '' || reqPath === 'index.html') {
        reqPath = 'index.html';
      }

      const file = EMBEDDED_WEB_FILES[reqPath];
      if (file) {
        reply.header('Content-Type', file.contentType);
        if (file.encoding === 'base64') {
          return reply.send(Buffer.from(file.content, 'base64'));
        }
        return reply.send(file.content);
      }

      // 非 API 路径统一 fallback 到 index.html (SPA 客户端路由)
      if (!req.url.startsWith('/api')) {
        const indexFile = EMBEDDED_WEB_FILES['index.html'];
        if (indexFile) {
          reply.header('Content-Type', indexFile.contentType);
          return reply.send(indexFile.content);
        }
      }

      return reply.code(404).send({ success: false, msg: '资源不存在' });
    });
  }

  // 11. 建立全双工实时 WebSocket (用于状态与日志统一推送，天然兼容 ws:// 与 wss://)
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req: any) => {
    // 首次连入立即推送全量状态与近期日志
    try {
      ws.send(
        JSON.stringify({
          type: 'status',
          data: {
            needAuth: Boolean(manager.adminPassword),
            keepAliveSeconds: manager.keepAliveSeconds,
            accounts: manager.getAccountsSummary(),
          },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'init_logs',
          logs: manager.getRecentLogs(),
        }),
      );
    } catch {}

    // 订阅后续状态变更与新日志
    const unSubStatus = manager.subscribeStatus(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(
            JSON.stringify({
              type: 'status',
              data: {
                needAuth: Boolean(manager.adminPassword),
                keepAliveSeconds: manager.keepAliveSeconds,
                accounts: manager.getAccountsSummary(),
              },
            }),
          );
        } catch {}
      }
    });

    const unSubLogs = manager.subscribeLogs((log) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          if (log.message === '__CLEAR__') {
            ws.send(JSON.stringify({ type: 'init_logs', logs: [] }));
          } else {
            ws.send(JSON.stringify({ type: 'log', log }));
          }
        } catch {}
      }
    });

    ws.on('close', () => {
      unSubStatus();
      unSubLogs();
    });
  });

  // 挂载到 Fastify 底层 HTTP Server 的 upgrade 事件
  fastify.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      if (manager.adminPassword && (!token || !isValidToken(token))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  (fastify as any).manager = manager;
  // 注册天翼云官方反代与免密直通视窗模块
  registerDesktopProxyRoutes(fastify, manager, verifyAuth);

  return fastify;
}
