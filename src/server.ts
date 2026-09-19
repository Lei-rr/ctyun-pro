import Fastify, { type FastifyError } from 'fastify';
import { ProfileManager } from './core/profile-manager.js';
import { registerDesktopProxyRoutes } from './routes/desktop-proxy.js';
import {
  authRoutes,
  createAuthContext,
  registerAuthGuard,
  systemRoutes,
  profileRoutes,
  taskRoutes,
  desktopRoutes,
  logRoutes,
  staticRoutes,
  setupWebSocket,
} from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    manager: ProfileManager;
  }
}

export async function createServer(managerInstance?: ProfileManager) {
  const manager = managerInstance || new ProfileManager();
  const fastify = Fastify({
    logger: false,
  });

  // 全局统一未捕获异常处理拦截器 (规范响应格式，防止敏感堆栈泄露)
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;
    const msg = error.message || '系统内部异常';
    manager.addLog('error', `${request.method} ${request.url} -> ${statusCode}: ${msg}`, { source: 'api' });
    reply.code(statusCode).send({
      success: false,
      msg,
    });
  });

  // 支持无 body 的 application/json POST/PUT 请求 (如前端带 Header 的动作触发请求)
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
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

  // 支持所有其他媒体类型直接以 Buffer 透传 (供反向代理等场景直通，防止 415 Unsupported Media Type)
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // 短信验证会话内存缓存 (带 10 分钟自动过期 TTL，防止垃圾残留)
  class ExpiringSmsSessionCache extends Map<string, { captchaKey?: string; expireAt: number }> {
    private cleanupTimer: NodeJS.Timeout;
    constructor() {
      super();
      this.cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, val] of this.entries()) {
          if (val.expireAt <= now) {
            this.delete(key);
          }
        }
      }, 60 * 1000);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
    destroy() {
      clearInterval(this.cleanupTimer);
      this.clear();
    }
  }
  const smsSessionCache = new ExpiringSmsSessionCache();

  fastify.addHook('onClose', async () => {
    smsSessionCache.destroy();
  });

  // 1. 初始化鉴权凭据与验证上下文，并注册全局 API 鉴权守卫
  const authContext = createAuthContext(manager);
  registerAuthGuard(fastify, authContext);

  // 2. 挂载业务路由插件
  await fastify.register(authRoutes, { manager, authContext });
  await fastify.register(systemRoutes, { manager });
  await fastify.register(profileRoutes, { manager, smsSessionCache });
  await fastify.register(taskRoutes, { manager });
  await fastify.register(desktopRoutes, { manager });
  await fastify.register(logRoutes, { manager, authContext });
  await fastify.register(staticRoutes);

  // 3. 挂载云电脑免密全屏直连反向代理
  registerDesktopProxyRoutes(fastify, manager, authContext.verifyAuth);

  // 4. 初始化 WebSocket 全双工推送通道
  setupWebSocket(fastify, manager, authContext);

  // 5. 挂载全局 manager 引用供停机生命周期调用
  fastify.decorate('manager', manager);

  return fastify;
}
