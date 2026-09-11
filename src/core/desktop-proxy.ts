import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { ProfileManager } from './profile-manager.js';

// 官方 HTML 入口与静态资源全局缓存 (带容量上限与过期控制)
let cachedIndexHtml: string | null = null;
let lastIndexHtmlFetch = 0;
const HTML_CACHE_TTL = 3600 * 1000; // 1 小时

// 内存静态资源缓存限制
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
let currentCacheSizeBytes = 0;
const ctyunStaticCache = new Map<string, { buffer: Buffer; contentType: string; size: number; timestamp: number }>();

/**
 * 基于 Node.js 原生 https 发起 IPv4 请求（规避容器与云厂商环境 IPv6 路由不可达导致 fetch failed / ETIMEDOUT）
 */
function requestBufferIpv4(urlStr: string, headers: Record<string, string> = {}): Promise<{ buffer: Buffer; contentType: string; status: number }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const clientModule = isHttps ? https : http;
    const req = clientModule.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          ...headers,
        },
        family: 4,
        rejectUnauthorized: false,
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const contentType = (res.headers['content-type'] as string) || 'application/octet-stream';
          resolve({ buffer, contentType, status: res.statusCode || 200 });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (15000ms): ${urlStr}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 获取天翼云官方 PC 客户端入口 HTML 骨架
 */
async function getCtyunIndexHtml(): Promise<string> {
  const now = Date.now();
  if (cachedIndexHtml && now - lastIndexHtmlFetch < HTML_CACHE_TTL) {
    return cachedIndexHtml;
  }

  const res = await requestBufferIpv4('https://pc.ctyun.cn/');
  if (res.status >= 400) {
    throw new Error(`拉取天翼云入口网页失败: HTTP ${res.status}`);
  }

  const text = res.buffer.toString('utf-8');
  cachedIndexHtml = text;
  lastIndexHtmlFetch = now;
  return text;
}

/**
 * 代理静态资源并执行内存安全缓存
 */
async function proxyStaticAsset(reply: FastifyReply, targetUrl: string): Promise<void> {
  const cached = ctyunStaticCache.get(targetUrl);
  if (cached) {
    reply
      .header('Content-Type', cached.contentType)
      .header('Cache-Control', 'public, max-age=86400')
      .send(cached.buffer);
    return;
  }

  try {
    const upstream = await requestBufferIpv4(targetUrl, {
      Referer: 'https://pc.ctyun.cn/',
    });

    if (upstream.status >= 400) {
      reply.code(upstream.status).send(`Upstream Error: HTTP ${upstream.status}`);
      return;
    }

    const contentType = upstream.contentType;
    const buffer = upstream.buffer;

    // LRU 淘汰：若超出容量先清理旧资源
    if (currentCacheSizeBytes + buffer.length > MAX_CACHE_SIZE_BYTES) {
      const oldestKey = ctyunStaticCache.keys().next().value;
      if (oldestKey) {
        const item = ctyunStaticCache.get(oldestKey);
        if (item) currentCacheSizeBytes -= item.size;
        ctyunStaticCache.delete(oldestKey);
      }
    }

    if (buffer.length < 10 * 1024 * 1024) {
      ctyunStaticCache.set(targetUrl, {
        buffer,
        contentType,
        size: buffer.length,
        timestamp: Date.now(),
      });
      currentCacheSizeBytes += buffer.length;
    }

    reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=86400')
      .send(buffer);
  } catch (err: any) {
    reply.code(502).send(`Gateway Proxy Error: ${err.message}`);
  }
}

/**
 * 注册天翼云桌面反代路由与免密注入中间件
 */
export function registerDesktopProxyRoutes(
  fastify: FastifyInstance,
  manager: ProfileManager,
  verifyAuth: (request: any, reply: any) => boolean,
): void {
  // 1. 云电脑 Web 免密直通操作视窗 (拉取官方最新骨架，现代化注入免密凭据与沉浸式骨架屏)
  // 同时支持 /view (推荐) 与 /desktop-view (向下兼容)
  const renderDesktopView = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;

    const params = request.params as { id?: string };
    const query = request.query as { desktopId?: string; id?: string };
    const desktopId = params?.id || query.desktopId || query.id;
    if (!desktopId) {
      reply.code(400).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif;padding:20px;">缺少云电脑 ID</h3>');
      return;
    }

    try {
      // 1. 通过 desktopId 查找对应的账号与桌面
      const target = manager.findDesktopById(desktopId);
      if (!target) {
        reply.code(404).type('text/html; charset=utf-8').send(`<h3 style="font-family:sans-serif;padding:20px;">未检测到可用云电脑 (ID: ${desktopId})</h3>`);
        return;
      }

      const { accountName, desktop } = target;
      const client = manager.getClient(accountName);
      if (!client) {
        reply.code(401).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif;padding:20px;">账号不存在或未初始化</h3>');
        return;
      }

      if (!client.loginInfo) {
        reply.code(401).type('text/html; charset=utf-8').send(`<h3 style="font-family:sans-serif;padding:20px;">账号【${accountName}】未登录或凭据已失效，请在控制台重新登录</h3>`);
        return;
      }

      // 2. 核心避让机制：用户准备打开浏览器独立操作云电脑，后台长连接保活自动断开让位
      // 杜绝“AI云电脑在其他地方登录，您已被强制下线”的互踢冲突！
      manager.touchWebUserActive(accountName, desktopId, 60);

      const objId = desktop.objId || desktop.desktopId || desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');
      const desktopDisplayName = desktop.desktopName || `云电脑 ${desktopId}`;

      const authDataObj = {
        ...client.loginInfo,
        logined: true,
        userId: client.loginInfo?.userId,
        userName: client.loginInfo?.userName,
        userEid: (client.loginInfo as any)?.userEid || '',
        userAccount: client.loginInfo?.userAccount || '',
        mobilephone: client.loginInfo?.mobilephone || accountName,
        tenantId: client.loginInfo?.tenantId,
        secretKey: client.loginInfo?.secretKey,
        deviceType: (client as any).deviceType || '60',
        bondedDevice: true,
        commonLoginReqHeader: (client.loginInfo as any)?.commonLoginReqHeader || '',
        timestamp: Date.now(),
      };

      let html = await getCtyunIndexHtml();

      // 现代化注入脚本：深色质感骨架屏、凭据自动化注水、API 代理拦截、前台 Web 避让心跳保持
      const injectScript = `
<style>
  #ctyun-modern-loader {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: #09090b;
    z-index: 999999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e4e4e7;
    transition: opacity 0.5s ease;
  }
  .c-spinner {
    width: 44px;
    height: 44px;
    border: 3px solid rgba(255, 255, 255, 0.1);
    border-radius: 50%;
    border-top-color: #3b82f6;
    animation: c-spin 0.8s linear infinite;
    margin-bottom: 16px;
  }
  @keyframes c-spin {
    to { transform: rotate(360deg); }
  }
  .c-text {
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.5px;
    color: #a1a1aa;
  }
</style>
<div id="ctyun-modern-loader">
  <div class="c-spinner"></div>
  <div class="c-text">正在安全接入官方云电脑原生视窗...</div>
</div>
<script>
(function() {
  const desktopId = ${JSON.stringify(desktopId)};
  const accountName = ${JSON.stringify(accountName)};
  const token = ${JSON.stringify((client.loginInfo as any)?.token || '')};
  const authData = ${JSON.stringify(authDataObj)};
  const deviceCode = ${JSON.stringify(client.getDeviceCode())};
  const expiredAt = ${JSON.stringify(String(Date.now() + 72 * 3600 * 1000))};

  // 1. 多标签页同源隔离：透明沙箱化 Storage (以 desktopId 为命名空间彻底防串号)
  const nsPrefix = 'ctyun_' + desktopId + '_';
  const isolateKeys = new Set([
    'web_device_code', 'authExpiredAt', 'authData', 'judgeUserEId', 
    'loginAt', 'user_name', 'userId', 'token', 'commonLoginReqHeader'
  ]);

  const origLocalGet = Storage.prototype.getItem;
  const origLocalSet = Storage.prototype.setItem;
  const origLocalRemove = Storage.prototype.removeItem;

  Storage.prototype.getItem = function(key) {
    if (this === window.localStorage && isolateKeys.has(key)) {
      const val = origLocalGet.call(this, nsPrefix + key);
      if (val !== null) return val;
    }
    return origLocalGet.call(this, key);
  };

  Storage.prototype.setItem = function(key, value) {
    if (this === window.localStorage && isolateKeys.has(key)) {
      return origLocalSet.call(this, nsPrefix + key, value);
    }
    return origLocalSet.call(this, key, value);
  };

  Storage.prototype.removeItem = function(key) {
    if (this === window.localStorage && isolateKeys.has(key)) {
      return origLocalRemove.call(this, nsPrefix + key);
    }
    return origLocalRemove.call(this, key);
  };

  try {
    localStorage.setItem('web_device_code', deviceCode);
    localStorage.setItem('authExpiredAt', expiredAt);
    localStorage.setItem('authData', JSON.stringify(authData));
    localStorage.setItem('judgeUserEId', authData.userEid || '');
    localStorage.setItem('loginAt', Date.now().toString());
    sessionStorage.setItem('authExpiredAt', expiredAt);
    sessionStorage.setItem('authData', JSON.stringify(authData));
    sessionStorage.setItem('user_name', authData.userName || '');
    sessionStorage.setItem('userId', String(authData.userId || ''));
  } catch (e) {
    console.error('Failed to set localStorage', e);
  }

  // 2. 前台 Web 视窗活跃心跳与避让同步机制 (基于桌面唯一 ID 寻址，免传 account)\n  function sendWebHeartbeat() {\n    try {\n      fetch('/api/instances/' + encodeURIComponent(desktopId) + '/web-active', {\n        method: 'POST',\n      }).catch(() => {});\n    } catch (e) {}\n  }\n  setInterval(sendWebHeartbeat, 15000);\n\n  // 页面关闭或卸载时通知后端立即恢复保活连接 (基于桌面唯一 ID 寻址，免传 account)\n  window.addEventListener('beforeunload', function() {\n    try {\n      if (navigator.sendBeacon) {\n        navigator.sendBeacon('/api/instances/' + encodeURIComponent(desktopId) + '/web-close');\n      }\n    } catch (e) {}\n  });

  // 3. 现代流媒体代理拦截器 (优雅重写跨域与 Origin 防盗链)
  const proxyBase = '/api/ctyun-proxy?target=';
  function rewriteUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith(proxyBase)) return u;
    if (u.includes('.ctyun.cn:8810') || u.includes('.ctyun.cn:8816') || u.includes('-deskmgr.ctyun.cn')) {
      return proxyBase + encodeURIComponent(u);
    }
    return u;
  }

  const origFetch = window.fetch;
  window.fetch = function(resource, init) {
    if (typeof resource === 'string') {
      resource = rewriteUrl(resource);
    } else if (resource && resource.url) {
      const newUrl = rewriteUrl(resource.url);
      resource = new Request(newUrl, resource);
    }
    return origFetch.call(this, resource, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    url = rewriteUrl(url);
    return origOpen.call(this, method, url, ...args);
  };

  // 4. 视网膜高清与高分辨率锁定 (破解官方自适应协商降质算法)
  try {
    // 锁定最高像素比与视口尺寸协商
    Object.defineProperty(window, 'devicePixelRatio', {
      get: function() { return Math.max(window.devicePixelRatio || 1, 1.25); },
      configurable: true
    });
  } catch (e) {}

  // 5. 跨端双向剪贴板智能中转隧道 (窗口聚焦时静默读取并同步)
  let lastCopiedText = '';
  async function syncClipboardToRemote() {
    try {
      if (!document.hasFocus() || !navigator.clipboard || !navigator.clipboard.readText) return;
      const text = await navigator.clipboard.readText();
      if (text && text !== lastCopiedText && text.length < 50000) {
        lastCopiedText = text;
        // 尝试通过官方剪贴板接口或全局总线广播
        if (window.postMessage) {
          window.postMessage({ type: 'CTYUN_CLIPBOARD_INJECT', data: text }, '*');
        }
      }
    } catch (e) {}
  }
  window.addEventListener('focus', syncClipboardToRemote);
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) syncClipboardToRemote();
  });

  // 6. 锁定目标云电脑推流哈希
  const targetHash = '#/desktop?id=' + ${JSON.stringify(encodeURIComponent(b64Id))};
  if (!window.location.hash || window.location.hash.includes('/login') || window.location.hash.includes('/desktop-list')) {
    window.location.hash = targetHash;
  }

  // 7. 重定向 Web Worker 至本地代理通道
  const OrigWorker = window.Worker;
  window.Worker = function(scriptUrl, options) {
    if (typeof scriptUrl === 'string' && scriptUrl.includes('bbenc.worker.js')) {
      scriptUrl = '/workers/bbenc.worker.js';
    }
    return new OrigWorker(scriptUrl, options);
  };

  // 8. 画面就绪后平滑淡出加载层
  const dismissLoader = () => {
    const loader = document.getElementById('ctyun-modern-loader');
    if (loader) {
      loader.style.opacity = '0';
      setTimeout(() => loader.remove(), 500);
    }
  };
  window.addEventListener('DOMContentLoaded', () => setTimeout(dismissLoader, 1500));
  setTimeout(dismissLoader, 4000);
})();
</script>
`;

      html = html.replace('<head>', `<head><title>CTYUN-PRO · ${desktopDisplayName}</title>${injectScript}`);
      html = html.replace(/src="static\//g, 'src="/ctyun-static/static/');
      html = html.replace(/src="\.\/static\//g, 'src="/ctyun-static/static/');
      html = html.replace(/href="\.\/static\//g, 'href="/ctyun-static/static/');
      html = html.replace(/href="\.\/manifest\.json"/g, 'href="/ctyun-static/manifest.json"');

      reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(html);
    } catch (err: any) {
      reply.code(500).type('text/html; charset=utf-8').send(`<h3 style="font-family:sans-serif;padding:20px;">连接云电脑服务异常: ${err.message}</h3>`);
    }
  };

  fastify.get('/view', renderDesktopView);
  fastify.get('/view/:id', renderDesktopView);
  fastify.get('/desktop-view', renderDesktopView);
  fastify.get('/desktop-view/:id', renderDesktopView);

  // 2. 接收前台 Web 用户活跃心跳 (刷新避让时长 30s)
  fastify.post('/api/instances/:id/web-active', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    manager.touchWebUserActive('', id, 30);
    reply.send({ success: true });
  });

  // 3. 接收前台 Web 用户退出通知 (提前解除避让恢复保活)
  fastify.post('/api/instances/:id/web-close', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    manager.releaseWebUserActive('', id);
    reply.send({ success: true });
  });

  // 4. 代理天翼云 Web Worker 解码器
  fastify.get('/workers/:filename', async (request: FastifyRequest, reply: FastifyReply) => {
    const { filename } = request.params as { filename: string };
    const targetUrl = `https://pc.ctyun.cn/workers/${filename || 'bbenc.worker.js'}`;
    await proxyStaticAsset(reply, targetUrl);
  });

  // 5. 代理天翼云静态资源 (/ctyun-static/*)
  fastify.get('/ctyun-static/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = request.raw.url || '';
    const relPath = rawUrl.replace(/^\/ctyun-static\//, '').replace(/^\/+/, '');
    const targetUrl = `https://pc.ctyun.cn/${relPath}`;
    await proxyStaticAsset(reply, targetUrl);
  });

  // 6. 天翼云 API 反向代理通道 (流式管道，防盗链透传与全跨域开放)
  const proxyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const req = request.raw;
    const res = reply.raw;
    reply.hijack();

    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const targetUrl = parsedUrl.searchParams.get('target');

    if (!targetUrl) {
      reply.code(400).send({ error: 'Missing target parameter' });
      return;
    }

    let parsedTarget: URL;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      reply.code(400).send({ error: 'Invalid target URL' });
      return;
    }

    // 放行 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        .header('Access-Control-Allow-Headers', '*')
        .send();
      return;
    }

    // 伪装 Origin 与 Referer，消除跨域与防盗链拦截
    const proxyHeaders = { ...req.headers };
    delete proxyHeaders.host;
    delete proxyHeaders['content-length'];
    proxyHeaders['origin'] = 'https://pc.ctyun.cn';
    proxyHeaders['referer'] = 'https://pc.ctyun.cn/';
    proxyHeaders['host'] = parsedTarget.host;

    const isHttps = parsedTarget.protocol === 'https:';
    const clientModule = isHttps ? https : http;

    const proxyReq = clientModule.request(
      parsedTarget,
      {
        method: req.method,
        headers: proxyHeaders,
        family: 4,
        rejectUnauthorized: false,
      },
      (proxyRes) => {
        const responseHeaders = { ...proxyRes.headers };
        responseHeaders['access-control-allow-origin'] = '*';
        responseHeaders['access-control-allow-credentials'] = 'true';
        responseHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        responseHeaders['access-control-allow-headers'] = '*';

        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        reply.code(502).send({ error: `Proxy Error: ${err.message}` });
      }
    });

    // 将客户端请求体流式管道导入上游代理
    req.pipe(proxyReq);
  };

  fastify.all('/api/ctyun-proxy', proxyHandler);
}
