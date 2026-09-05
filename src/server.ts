import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import { Config } from './config.js';
import { AccountManager } from './core/index.js';
import { CtYunClient, type ChallengeData } from './core/client.js';
import { TaskRunner } from './tasks/index.js';
import { safeWriteFileSync } from './core/utils.js';

export async function createServer() {
  const fastify = Fastify({
    logger: false,
  });

  await fastify.register(cors, {
    origin: true,
  });

  const manager = new AccountManager();
  
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
  const verifyAuth = (request: any, reply: any): boolean => {
    if (!manager.adminPassword) {
      return true;
    }
    const token =
      request.headers['x-admin-token'] ||
      (request.query && request.query.token) ||
      (request.headers.authorization ? request.headers.authorization.replace(/^Bearer\s+/i, '') : '');
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
    return { success: true, token };
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
      },
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

  // 2. 更新保活周期
  fastify.post('/api/config/keepalive', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { seconds: number };
    if (!body || !body.seconds || body.seconds < 10) {
      return reply.code(400).send({ success: false, msg: '周期不能少于 10 秒' });
    }
    manager.keepAliveSeconds = body.seconds;
    manager.saveToDisk();
    manager.addLog('info', `保活重连周期已调整为 ${body.seconds} 秒`);
    return { success: true };
  });

  // 3. 获取登录图形验证码（官方原生验证码直连呈现）
  fastify.get('/api/account/captcha', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const query = request.query as { accountName?: string; user?: string };
    const user = query.user || query.accountName || '';
    const accountName = query.accountName || user || '__anonymous__';
    const client = manager.getClient(accountName);

    try {
      const challenge = await client.getChallengeData();
      challengeCache.set(accountName, challenge);
      challengeCache.set('__latest__', challenge);
      if (user) challengeCache.set(user, challenge);

      const imgBuffer = await client.getLoginCaptcha(user);

      return {
        success: true,
        data: {
          image: `data:image/jpeg;base64,${imgBuffer.toString('base64')}`,
        },
      };
    } catch (err: any) {
      reply.code(500).send({ success: false, msg: err.message });
    }
  });

  // 4. 用户提交账号密码 + 验证码执行登录
  fastify.post('/api/account/login', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as {
      accountName?: string;
      user: string;
      password?: string;
      captchaCode: string;
    };

    if (!body.user || !body.captchaCode) {
      return reply.code(400).send({ success: false, msg: '请填写完整账号与验证码' });
    }

    const accountName = body.accountName || body.user;
    const client = manager.getClient(accountName);
    // 优先从账号名、手机号或通用空键中读取有效 challenge
    let challenge =
      challengeCache.get(accountName) ||
      challengeCache.get(body.user) ||
      challengeCache.get('__latest__') ||
      challengeCache.get('__anonymous__') ||
      challengeCache.get('13800138000');

    if (!challenge) {
      try {
        challenge = await client.getChallengeData();
        challengeCache.set(accountName, challenge);
      } catch {
        return reply.code(400).send({ success: false, msg: '请先刷新验证码' });
      }
    }

    try {
      manager.addLog('info', `[${accountName}] 正在验证登录...`);
      const loginInfo = await client.login(
        body.user,
        body.password || '',
        challenge,
        body.captchaCode.trim(),
      );

      manager.addOrUpdateAccount({
        name: accountName,
        user: body.user,
        password: body.password,
        deviceCode: client.getDeviceCode(),
        loginInfo: loginInfo,
        autoStart: true,
      });

      if (!loginInfo.bondedDevice) {
        manager.addLog('warn', `[${accountName}] 设备未绑定，需要短信验证码确认`);
        return {
          success: true,
          needSms: true,
          msg: '登录成功，但当前设备未绑定，需要输入短信验证码',
        };
      }

      manager.addLog('success', `[${accountName}] 登录成功！正在启动云电脑保活...`);

      manager.startAccount(accountName).catch((e) => {
        manager.addLog('error', `[${accountName}] 启动保活失败: ${e.message}`);
      });

      return {
        success: true,
        needSms: false,
        msg: '登录成功并已启动保活',
      };
    } catch (err: any) {
      manager.addLog('error', `[${accountName}] 登录失败: ${err.message}`);
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 5. 获取短信图验图片
  fastify.get('/api/account/sms-captcha', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const query = request.query as { accountName: string };
    if (!query.accountName) {
      return reply.code(400).send({ success: false, msg: '缺少账号参数' });
    }
    const client = manager.getClient(query.accountName);
    try {
      const { image, captchaKey } = await client.getSmsCodeCaptcha();
      if (captchaKey) {
        const cur = smsSessionCache.get(query.accountName) || {};
        cur.captchaKey = captchaKey;
        smsSessionCache.set(query.accountName, cur);
      }
      reply.type('image/jpeg').send(image);
    } catch (err: any) {
      reply.code(500).send({ success: false, msg: err.message });
    }
  });

  // 6. 发送绑定设备短信
  fastify.post('/api/account/send-sms', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string; user: string; captchaCode: string };
    if (!body.accountName || !body.user || !body.captchaCode) {
      return reply.code(400).send({ success: false, msg: '参数不完整' });
    }
    const client = manager.getClient(body.accountName);
    const cachedKey = smsSessionCache.get(body.accountName)?.captchaKey || '';
    try {
      const { smsKey } = await client.sendSmsCode(body.user, body.captchaCode.trim(), cachedKey);
      if (smsKey) {
        const cur = smsSessionCache.get(body.accountName) || {};
        cur.smsKey = smsKey;
        smsSessionCache.set(body.accountName, cur);
      }
      manager.addLog('info', `[${body.accountName}] 短信验证码已发送至手机号 ${body.user}`);
      return { success: true };
    } catch (err: any) {
      manager.addLog('error', `[${body.accountName}] 发送短信失败: ${err.message}`);
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 7. 提交短信验证码绑定设备
  fastify.post('/api/account/bind-device', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string; smsCode: string };
    if (!body.accountName || !body.smsCode) {
      return reply.code(400).send({ success: false, msg: '请填写短信验证码' });
    }
    const client = manager.getClient(body.accountName);
    const cachedSmsKey = smsSessionCache.get(body.accountName)?.smsKey || '';
    try {
      await client.bindDevice(body.smsCode.trim(), cachedSmsKey);
      manager.saveToDisk();
      manager.addLog('success', `[${body.accountName}] 设备绑定成功！正在启动保活...`);

      manager.startAccount(body.accountName).catch((e) => {
        manager.addLog('error', `[${body.accountName}] 启动保活失败: ${e.message}`);
      });

      return { success: true, msg: '绑定成功并已启动保活' };
    } catch (err: any) {
      manager.addLog('error', `[${body.accountName}] 设备绑定失败: ${err.message}`);
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8. 手动启动 / 停止账号保活
  fastify.post('/api/account/action', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string; action: 'start' | 'stop' | 'delete' };
    if (!body.accountName || !body.action) {
      return reply.code(400).send({ success: false, msg: '参数不完整' });
    }

    if (body.action === 'start') {
      try {
        await manager.startAccount(body.accountName);
        return { success: true };
      } catch (err: any) {
        return reply.code(400).send({ success: false, msg: err.message });
      }
    } else if (body.action === 'stop') {
      manager.stopAccount(body.accountName);
      return { success: true };
    } else if (body.action === 'delete') {
      manager.removeAccount(body.accountName);
      return { success: true };
    }
    return reply.code(400).send({ success: false, msg: '未知操作' });
  });

  // 7.1 修改账号备注名称
  fastify.post('/api/account/rename', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { oldName: string; newName: string };
    if (!body || !body.oldName || !body.newName) {
      return reply.code(400).send({ success: false, msg: '缺少必要参数' });
    }
    try {
      manager.updateAccountName(body.oldName, body.newName);
      return { success: true };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.0 获取账号当前真实积分与每日三大任务进度 (优先支持按不可变 user 手机号查询)
  fastify.get('/api/account/points', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const query = request.query as { user?: string; accountName?: string };
    const key = query.user || query.accountName;
    if (!key) return reply.code(400).send({ success: false, msg: '缺少账号参数' });
    const acc = manager.getAccount(key);
    if (!acc) return reply.code(404).send({ success: false, msg: '未找到该账号' });
    const client = manager.getClient(acc.name);
    if (!client.loginInfo) return reply.code(400).send({ success: false, msg: '账号未登录' });
    try {
      const data = await manager.getPointsAndTasks(acc.name);
      return { success: true, data };
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message });
    }
  });

  // 8.1 手动触发签到
  fastify.post('/api/account/sign', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string };
    if (!body.accountName) return reply.code(400).send({ success: false, msg: '缺少账号' });
    try {
      const msg = await manager.manualSignIn(body.accountName);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.1.1 查询商城可兑换商品列表
  fastify.get('/api/rewards', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    try {
      const data = await manager.getAvailableRewards('', false);
      return { success: true, data };
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message });
    }
  });

  fastify.get('/api/account/rewards', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const query = request.query as { user?: string; accountName?: string; refresh?: string };
    const key = query.user || query.accountName;
    try {
      const data = await manager.getAvailableRewards(key || '', query.refresh === '1' || query.refresh === 'true');
      return { success: true, data };
    } catch (err: any) {
      return reply.code(500).send({ success: false, msg: err.message });
    }
  });

  // 8.2 手动触发兑换
  fastify.post('/api/account/redeem', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as {
      accountName: string;
      prodId?: number;
      costPoints?: number;
      prodType?: string;
      desktopId?: string;
    };
    if (!body.accountName) return reply.code(400).send({ success: false, msg: '缺少账号' });
    try {
      const msg = await manager.manualRedeem(
        body.accountName,
        body.prodId,
        body.costPoints,
        body.prodType,
        body.desktopId,
      );
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.2 手动执行每日打卡与任务推进
  fastify.post('/api/account/task/run', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string };
    if (!body.accountName) return reply.code(400).send({ success: false, msg: '缺少账号' });
    try {
      const msg = await manager.manualRunTasks(body.accountName);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.2.1 手动触发智能补足时长挂机
  fastify.post('/api/account/hang/run', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string };
    if (!body.accountName) return reply.code(400).send({ success: false, msg: '缺少账号' });
    try {
      const msg = await manager.manualHang(body.accountName);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.2.2 手动触发登录云电脑任务
  fastify.post('/api/account/task/login-desktop', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string };
    if (!body.accountName) return reply.code(400).send({ success: false, msg: '缺少账号' });
    try {
      const msg = await manager.manualActivateDesktop(body.accountName);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.2.3 手动触发AI对话任务
  fastify.post('/api/account/task/ai-chat', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as { accountName: string };
    if (!body.accountName) return reply.code(400).send({ success: false, msg: '缺少账号' });
    try {
      const msg = await manager.manualAiChat(body.accountName);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.3 更新签到、任务与兑换策略设置
  fastify.post('/api/account/policy', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as {
      accountName: string;
      autoSign?: boolean;
      taskConfig?: any;
      redeemConfig?: any;
    };
    if (!body.accountName) return reply.code(400).send({ success: false, msg: '缺少账号' });
    const existing = manager.getAccount(body.accountName);
    if (!existing) return reply.code(404).send({ success: false, msg: '未找到该账号' });

    await manager.addOrUpdateAccount({
      ...existing,
      autoSign: body.autoSign !== undefined ? body.autoSign : (body.taskConfig?.enabled ?? existing.autoSign),
      taskConfig: body.taskConfig !== undefined ? body.taskConfig : existing.taskConfig,
      redeemConfig: body.redeemConfig !== undefined ? body.redeemConfig : existing.redeemConfig,
    });
    manager.addLog('info', `[${body.accountName}] 自动化任务与兑换策略已保存`);
    return { success: true };
  });

  // 8.3 云电脑电源操作 (开机/关机/重启)
  fastify.post('/api/account/desktop/operate', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = request.body as {
      accountName: string;
      desktopId: string;
      operation: 'on' | 'shutdown' | 'reset';
    };
    if (!body.accountName || !body.desktopId || !body.operation) {
      return reply.code(400).send({ success: false, msg: '缺少必要参数' });
    }
    try {
      const msg = await manager.operateDesktop(body.accountName, body.desktopId, body.operation);
      return { success: true, msg };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 8.4 同步刷新云电脑真实状态
  fastify.post('/api/account/desktop/refresh', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    const body = (request.body || {}) as { accountName?: string };
    try {
      if (body.accountName) {
        await manager.reloadDesktops(body.accountName);
      } else {
        for (const name of manager.getAllAccounts().keys()) {
          await manager.reloadDesktops(name).catch(() => {});
        }
      }
      return { success: true, data: manager.getAccountsSummary() };
    } catch (err: any) {
      return reply.code(400).send({ success: false, msg: err.message });
    }
  });

  // 9. SSE 实时日志推流 (带 token 验证)
  fastify.get('/api/logs/stream', (request: any, reply) => {
    const token = request.query?.token;
    if (manager.adminPassword && (!token || !isValidToken(token))) {
      return reply.code(401).send('Unauthorized');
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const recent = manager.getRecentLogs();
    reply.raw.write(`data: ${JSON.stringify({ type: 'init', logs: recent })}\n\n`);

    const unsubscribe = manager.subscribeLogs((log) => {
      if (log.message === '__CLEAR__') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'init', logs: [] })}\n\n`);
      } else {
        reply.raw.write(`data: ${JSON.stringify({ type: 'log', log })}\n\n`);
      }
    });

    request.raw.on('close', () => {
      unsubscribe();
    });
  });

  // 9.1 清空服务端日志
  fastify.post('/api/logs/clear', async (request, reply) => {
    if (!verifyAuth(request, reply)) return;
    manager.clearLogs();
    return { success: true };
  });

  // 10. 静态页面宿主
  const webDist = path.resolve(process.cwd(), 'web/dist');
  const staticRoot = fs.existsSync(webDist) ? webDist : '';

  if (staticRoot) {
    await fastify.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
    });
    fastify.setNotFoundHandler((req, reply) => {
      // API 请求 404 返回 JSON，前端路由统一 fallback 到 index.html
      if (req.url.startsWith('/api')) {
        reply.code(404).send({ success: false, msg: 'API 接口不存在' });
      } else {
        reply.sendFile('index.html');
      }
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
  return fastify;
}
