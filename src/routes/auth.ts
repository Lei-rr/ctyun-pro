import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { ProfileManager } from '../core/profile-manager.js';
import { safeWriteFileSync } from '../infra/fs.js';
import { Config } from '../config.js';
import { timingSafeEqualString } from '../infra/crypto.js';
import { sendSuccess, sendError } from '../infra/reply.js';

export interface AuthContext {
  sessions: Set<string>;
  saveSessions: () => void;
  isValidToken: (token?: string) => boolean;
  verifyAuth: (request: FastifyRequest, reply: FastifyReply) => boolean;
  parseCookieToken: (cookieHeader?: string) => string;
}

// 登录防暴力破解内存速率限制器
interface LoginRateLimitState {
  failedAttempts: number;
  lockedUntil: number;
}
const loginRateLimits = new Map<string, LoginRateLimitState>();

export function checkLoginRateLimit(ip: string): { allowed: boolean; waitSeconds?: number } {
  const now = Date.now();
  const state = loginRateLimits.get(ip);
  if (!state) return { allowed: true };

  if (state.lockedUntil > now) {
    return {
      allowed: false,
      waitSeconds: Math.ceil((state.lockedUntil - now) / 1000),
    };
  }

  // 超过锁定时间，重置计数
  if (state.lockedUntil > 0 && state.lockedUntil <= now) {
    loginRateLimits.delete(ip);
  }
  return { allowed: true };
}

export function recordLoginAttempt(ip: string, success: boolean): void {
  const now = Date.now();
  if (success) {
    loginRateLimits.delete(ip);
    return;
  }
  const state = loginRateLimits.get(ip) || { failedAttempts: 0, lockedUntil: 0 };
  state.failedAttempts += 1;
  // 连续失败超过 5 次，锁定 60 秒
  if (state.failedAttempts >= 5) {
    state.lockedUntil = now + 60 * 1000;
  }
  loginRateLimits.set(ip, state);
}

export function createAuthContext(manager: ProfileManager): AuthContext {
  const sessions = new Set<string>();
  const sessionFile = path.resolve(Config.dataDir, 'sessions.json');

  const saveSessions = () => {
    try {
      safeWriteFileSync(sessionFile, JSON.stringify(Array.from(sessions), null, 2));
    } catch {}
  };

  // 清理超过 30 天的陈旧 Token，防止 sessions.json 无限膨胀
  const MAX_TOKEN_AGE_MS = 30 * 24 * 3600 * 1000;
  const purgeExpiredSessions = () => {
    const now = Date.now();
    let changed = false;
    for (const s of Array.from(sessions)) {
      const parts = s.split('.');
      if (parts.length === 2) {
        const ts = parseInt(parts[0], 10);
        if (Number.isFinite(ts) && now - ts > MAX_TOKEN_AGE_MS) {
          sessions.delete(s);
          changed = true;
        }
      }
    }
    if (changed) {
      saveSessions();
    }
  };

  try {
    if (fs.existsSync(sessionFile)) {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      if (content.trim()) {
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          data.forEach((s) => sessions.add(s));
        }
        purgeExpiredSessions();
      }
    }
  } catch {}

  const isValidToken = (token?: string): boolean => {
    if (!token) return false;
    if (token === 'no-auth' && !manager.adminPassword) return true;
    if (sessions.has(token)) return true;
    if (!manager.adminPassword) return false;

    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [ts, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', manager.adminPassword)
      .update(ts)
      .digest('hex');
    if (timingSafeEqualString(sig, expectedSig)) {
      sessions.add(token);
      saveSessions();
      return true;
    }
    return false;
  };

  const parseCookieToken = (cookieHeader?: string): string => {
    if (!cookieHeader) return '';
    const match = cookieHeader.match(/ctyun_admin_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  };

  const verifyAuth = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!manager.adminPassword) return true;
    const headers = request.headers as Record<string, string | undefined>;
    const token =
      headers['x-admin-token'] ||
      (headers.authorization ? headers.authorization.replace(/^Bearer\s+/i, '') : '') ||
      parseCookieToken(headers.cookie);
    if (!token || !isValidToken(token)) {
      sendError(reply, '未授权或登录已过期', 401);
      return false;
    }
    return true;
  };

  return {
    sessions,
    saveSessions,
    isValidToken,
    verifyAuth,
    parseCookieToken,
  };
}

export const authRoutes: FastifyPluginAsync<{
  manager: ProfileManager;
  authContext: AuthContext;
}> = async (fastify, { manager, authContext }) => {
  const { sessions, saveSessions, isValidToken, parseCookieToken } = authContext;

  // 1. 系统鉴权状态与登录接口
  fastify.get('/api/auth/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const needAuth = Boolean(manager.adminPassword);
    let authenticated = !needAuth;
    if (needAuth) {
      const headers = request.headers as Record<string, string | undefined>;
      const token =
        headers['x-admin-token'] ||
        (headers.authorization ? headers.authorization.replace(/^Bearer\s+/i, '') : '');
      authenticated = isValidToken(token);
    }
    return sendSuccess(reply, {
      needAuth,
      authenticated,
    });
  });

  // 2. 管理员登录
  fastify.post('/api/auth/login', async (request: FastifyRequest<{ Body: { password?: string } }>, reply: FastifyReply) => {
    const ip = request.ip || 'unknown';
    const rateCheck = checkLoginRateLimit(ip);
    if (!rateCheck.allowed) {
      return sendError(reply, `尝试次数过多，请等待 ${rateCheck.waitSeconds} 秒后再试`, 429);
    }

    const body = request.body || {};
    if (!manager.adminPassword) {
      recordLoginAttempt(ip, true);
      return sendSuccess(reply, { token: 'no-auth' });
    }
    if (!body || !timingSafeEqualString(body.password, manager.adminPassword)) {
      recordLoginAttempt(ip, false);
      return sendError(reply, '管理密码错误', 401);
    }
    recordLoginAttempt(ip, true);
    const ts = Date.now().toString();
    const sig = crypto
      .createHmac('sha256', manager.adminPassword)
      .update(ts)
      .digest('hex');
    const token = `${ts}.${sig}`;
    sessions.add(token);
    saveSessions();
    reply.header('Set-Cookie', `ctyun_admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
    return sendSuccess(reply, { token });
  });

  // 3. 注销登录 (作废服务端 Token 并清除客户端 Cookie)
  fastify.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = request.headers as Record<string, string | undefined>;
    const token =
      headers['x-admin-token'] ||
      (headers.authorization ? headers.authorization.replace(/^Bearer\s+/i, '') : '') ||
      parseCookieToken(headers.cookie);
    if (token && sessions.has(token)) {
      sessions.delete(token);
      saveSessions();
    }
    reply.header(
      'Set-Cookie',
      'ctyun_admin_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    );
    return sendSuccess(reply, null, '已安全退出登录');
  });

  // 4. 修改管理员密码
  fastify.post('/api/auth/password', async (request: FastifyRequest<{ Body: { newPassword?: string } }>, reply: FastifyReply) => {
    const body = request.body || {};
    manager.adminPassword = body.newPassword ? body.newPassword.trim() : '';
    manager.saveToDisk();
    sessions.clear();
    saveSessions();
    manager.addLog('info', manager.adminPassword ? '已更新控制台管理密码' : '已取消控制台管理密码', { source: 'api' });
    return sendSuccess(reply, null, manager.adminPassword ? '管理密码已更新' : '已取消管理密码');
  });
};

/** 免除全局鉴权的公开路径 (登录态查询、登录、登出、健康检查、SSE 流) */
const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/logs/stream',
]);

/**
 * 注册全局 API 鉴权守卫
 * 对所有 /api/* 路由统一校验，免除各路由内重复的 verifyAuth 样板
 */
export function registerAuthGuard(fastify: FastifyInstance, authContext: AuthContext): void {
  fastify.addHook('onRequest', async (request, reply) => {
    const path = (request.url || '').split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (PUBLIC_API_PATHS.has(path)) return;
    // 未授权时 verifyAuth 已写入 401 响应，返回 reply 以短路后续处理链
    if (!authContext.verifyAuth(request, reply)) return reply;
  });
}
