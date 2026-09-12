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

  let text = res.buffer.toString('utf-8');
  // 彻底移除官方 serviceWorker 注册逻辑，杜绝非同源与非标准 scope 导致的 SecurityError
  text = text.replace(/navigator\.serviceWorker\.register\([^)]+\)/g, 'Promise.resolve()');
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

    // LRU 淘汰：若超出容量循环清理旧资源
    while (currentCacheSizeBytes + buffer.length > MAX_CACHE_SIZE_BYTES && ctyunStaticCache.size > 0) {
      const oldestKey = ctyunStaticCache.keys().next().value;
      if (!oldestKey) break;
      const item = ctyunStaticCache.get(oldestKey);
      if (item) currentCacheSizeBytes -= item.size;
      ctyunStaticCache.delete(oldestKey);
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
  // 1. 云电脑 Web 免密直通操作视窗 (顶级 RESTful 直连: /desktop/:id)
  const renderDesktopView = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;

    const params = request.params as { id?: string };
    const desktopCode = params?.id;
    if (!desktopCode) {
      reply.code(400).type('text/html; charset=utf-8').send('<h3 style="font-family:sans-serif;padding:20px;">缺少云电脑设备编码 (desktopCode)</h3>');
      return;
    }

    try {
      // 1. 通过 desktopCode 查找对应的账号与桌面
      const target = manager.findDesktopById(desktopCode);
      if (!target) {
        reply.code(404).type('text/html; charset=utf-8').send(`<h3 style="font-family:sans-serif;padding:20px;">未检测到可用云电脑 (设备编码: ${desktopCode})</h3>`);
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
      manager.touchWebUserActive(accountName, desktop.desktopCode, 60);

      const objId = desktop.objId || desktop.desktopId;
      const b64Id = Buffer.from(String(objId)).toString('base64');
      const desktopDisplayName = desktop.desktopName || `云电脑 ${desktop.desktopCode}`;

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

      const safeJson = (val: any) => JSON.stringify(val).replace(/</g, '\\u003c');

      // 现代化注入脚本：深色质感骨架屏、凭据自动化注水、API 代理拦截、前台 Web 避让心跳保持
      const injectScript = `
<style>
  html, body {
    background: #09090b !important;
  }
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
    transition: opacity 0.4s ease;
  }
  #ctyun-modern-loader.fade-out {
    opacity: 0;
    pointer-events: none;
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
  <div class="c-text">[ CTYUN-PRO ] 正在初始化连接云电脑...</div>
</div>
<script>
(function() {
  const desktopCode = ${safeJson(desktop.desktopCode)};
  const accountName = ${safeJson(accountName)};
  const token = ${safeJson((client.loginInfo as any)?.token || '')};
  const authData = ${safeJson(authDataObj)};
  const deviceCode = ${safeJson(client.getDeviceCode())};
  const expiredAt = ${safeJson(String(Date.now() + 72 * 3600 * 1000))};

  // 动态锁定并维持自定义标题：原有标题 + " - CTYUN-PRO"
  const origOfficialTitle = '天翼量子AI云电脑';
  const targetTitle = origOfficialTitle + ' - CTYUN-PRO';
  document.title = targetTitle;

  // 监控官方 SPA 路由动态篡改标题，持续锁定
  try {
    const titleEl = document.querySelector('title');
    if (titleEl) {
      titleEl.textContent = targetTitle;
      const obs = new MutationObserver(() => {
        if (document.title !== targetTitle) {
          document.title = targetTitle;
        }
      });
      obs.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  } catch (e) {}

  // 0. 禁用 WebTransport，强制天翼云平滑降级至稳定的原生 WebSocket 通道 (消除 WebTransportError)
  try {
    delete window.WebTransport;
  } catch (e) {}
  try {
    window.WebTransport = undefined;
  } catch (e) {}

  // 1. 多标签页同源隔离：透明沙箱化 Storage (以 desktopCode 为命名空间彻底防串号)
  const nsPrefix = 'ctyun_' + desktopCode + '_';
  const isolateKeys = new Set([
    'web_device_code', 'authExpiredAt', 'authData', 'judgeUserEId', 
    'loginAt', 'user_name', 'userId', 'token', 'commonLoginReqHeader',
    'banner-historyUserId'
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
    localStorage.setItem('user_name', authData.userName || '');
    localStorage.setItem('userId', String(authData.userId || ''));
    localStorage.setItem('token', token || '');
    localStorage.setItem('commonLoginReqHeader', authData.commonLoginReqHeader || '');
    localStorage.setItem('banner-historyUserId', String(authData.userId || ''));
    sessionStorage.setItem('authExpiredAt', expiredAt);
    sessionStorage.setItem('authData', JSON.stringify(authData));
    sessionStorage.setItem('user_name', authData.userName || '');
    sessionStorage.setItem('userId', String(authData.userId || ''));
    sessionStorage.setItem('token', token || '');
  } catch (e) {
    console.error('Failed to set localStorage', e);
  }

  // 2. 前台 Web 视窗活跃心跳与避让同步机制 (基于桌面唯一 desktopCode 寻址，免传 account)
  function sendWebHeartbeat() {
    try {
      fetch('/api/desktops/' + encodeURIComponent(desktopCode) + '/web-active', {
        method: 'POST',
      }).catch(() => {});
    } catch (e) {}
  }
  setInterval(sendWebHeartbeat, 15000);

  // 页面关闭或卸载时通知后端立即恢复保活连接 (基于桌面唯一 desktopCode 寻址，免传 account)
  window.addEventListener('beforeunload', function() {
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/desktops/' + encodeURIComponent(desktopCode) + '/web-close');
      }
    } catch (e) {}
  });

  // 3. 现代流媒体代理拦截器 (优雅重写跨域与 Origin 防盗链)
  const proxyBase = '/api/ctyun-proxy?target=';
  function rewriteUrl(u) {
    if (!u || typeof u !== 'string') return u;
    if (u.startsWith(proxyBase)) return u;
    if (u.startsWith('https://') || u.startsWith('http://')) {
      if (u.includes('.ctyun.cn') || u.includes('-deskmgr.ctyun.cn')) {
        // 排除官方 CDN 静态分块 (由本地专有缓存通道分发，不走 API 代理)
        if (u.includes('deskcdn.ctyun.cn/pccdnstatic/')) {
          return '/ctyun-static/pccdnstatic/' + u.split('deskcdn.ctyun.cn/pccdnstatic/')[1];
        }
        return proxyBase + encodeURIComponent(u);
      }
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
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments, 2);
    url = rewriteUrl(url);
    return origOpen.apply(this, [method, url].concat(args));
  };

  // 4. 跨端双向剪贴板智能中转隧道 (窗口聚焦时静默读取并同步)
  let lastCopiedText = '';
  async function syncClipboardToRemote() {
    try {
      if (!document.hasFocus() || !navigator.clipboard || !navigator.clipboard.readText) return;
      const text = await navigator.clipboard.readText();
      if (text && text !== lastCopiedText && text.length < 50000) {
        lastCopiedText = text;
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

  // 5. 全局快捷键锁定 (Keyboard Lock API: 拦截并透传 Alt+Tab, Win键, Ctrl+W 等系统快捷键)
  async function requestKeyboardLock() {
    try {
      if ('keyboard' in navigator && typeof navigator.keyboard.lock === 'function') {
        // 独占锁定高频系统级与浏览器热键
        await navigator.keyboard.lock([
          'Tab', 'Escape', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
          'KeyW', 'KeyN', 'KeyT', 'KeyQ', 'KeyR'
        ]);
      }
    } catch (e) {}
  }
  // 在全屏变化或用户点击画面时自动申请键鼠独占锁定
  document.addEventListener('fullscreenchange', function() {
    if (document.fullscreenElement) {
      requestKeyboardLock();
    }
  });
  window.addEventListener('click', function() {
    if (document.fullscreenElement) {
      requestKeyboardLock();
    }
  }, { once: false });

  // 6. 锁定目标云电脑推流哈希与防登出守卫
  const targetHash = '#/desktop?id=' + ${JSON.stringify(encodeURIComponent(b64Id))};
  if (!window.location.hash || window.location.hash.includes('/login') || window.location.hash.includes('/desktop-list')) {
    window.location.hash = targetHash;
  }
  window.addEventListener('hashchange', function() {
    if (window.location.hash.includes('/login')) {
      window.location.hash = targetHash;
    }
  });

  // 7. 重定向 Web Worker 至本地代理通道
  const OrigWorker = window.Worker;
  window.Worker = function(scriptUrl, options) {
    if (typeof scriptUrl === 'string' && scriptUrl.includes('bbenc.worker.js')) {
      return new OrigWorker('/workers/bbenc.worker.js', options);
    }
    return new OrigWorker(scriptUrl, options);
  };

  // 8. 智能防穿透黑屏遮罩：严格遮蔽 desktop-list 初始化与握手阶段，无缝直达 desktop 视窗
  let dismissed = false;
  const dismissLoader = () => {
    if (dismissed) return;
    dismissed = true;
    const loader = document.getElementById('ctyun-modern-loader');
    if (loader) {
      loader.classList.add('fade-out');
      setTimeout(() => {
        try { loader.remove(); } catch (e) {}
      }, 500);
    }
  };

  let checkTimer = null;
  const checkDesktopReady = () => {
    if (dismissed) return;
    const hash = window.location.hash || '';
    // 如果仍在 desktop-list 列表页或登录拦截，绝对不放行遮罩，杜绝列表卡片闪烁
    if (hash.includes('desktop-list') || hash.includes('/login')) {
      return;
    }
    // 已经进入目标 desktop 视窗路由
    if (hash.includes('/desktop')) {
      const hasCanvas = !!document.querySelector('canvas');
      const hasVideo = !!document.querySelector('video');
      const hasBall = !!document.querySelector('.touch-ball-wrap, .btn-toolbar-ball-con, [class*="touch-ball"]');
      if (hasCanvas || hasVideo || hasBall) {
        if (checkTimer) {
          clearInterval(checkTimer);
          checkTimer = null;
        }
        // 画布/视频/悬浮球已挂载，平滑淡出，呈现直连视窗
        setTimeout(dismissLoader, 300);
      }
    }
  };

  // 高频持续检测 (100ms)
  checkTimer = setInterval(checkDesktopReady, 100);
  window.addEventListener('hashchange', checkDesktopReady);

  // 15秒安全保底：防止极端异常或未开机时无限黑屏
  setTimeout(() => {
    if (checkTimer) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    dismissLoader();
  }, 15000);
})();
</script>
`;

      html = html.replace('<head>', `<head><title>天翼量子AI云电脑 - CTYUN-PRO</title>${injectScript}`);
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

  // 顶级标准 RESTful 直连: /desktop/:id
  fastify.get('/desktop/:id', renderDesktopView);

  // 2. 接收前台 Web 用户活跃心跳 (刷新避让时长 30s)
  fastify.post('/api/desktops/:id/web-active', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    manager.touchWebUserActive('', id, 30);
    reply.send({ success: true });
  });

  // 3. 接收前台 Web 用户关闭通知 (立即清除避让标记，使后台长连接无缝复活)
  fastify.post('/api/desktops/:id/web-close', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    manager.releaseWebUserActive('', id);
    reply.send({ success: true });
  });

  // 4. 代理天翼云 Web Worker 解码器与 ServiceWorker
  fastify.get('/workers/:filename', async (request: FastifyRequest, reply: FastifyReply) => {
    const { filename } = request.params as { filename: string };
    const targetUrl = `https://pc.ctyun.cn/workers/${filename || 'bbenc.worker.js'}`;
    await proxyStaticAsset(reply, targetUrl);
  });

  fastify.get('/sw.js', async (request: FastifyRequest, reply: FastifyReply) => {
    const targetUrl = 'https://pc.ctyun.cn/sw.js';
    await proxyStaticAsset(reply, targetUrl);
  });

  fastify.get('/service-worker.js', async (request: FastifyRequest, reply: FastifyReply) => {
    const targetUrl = 'https://pc.ctyun.cn/service-worker.js';
    await proxyStaticAsset(reply, targetUrl);
  });

  // 4.1 代理根路径/同级下的 wasm 文件（如 main.*.wasm）
  fastify.get('/:filename.wasm', async (request: FastifyRequest, reply: FastifyReply) => {
    const { filename } = request.params as { filename: string };
    const targetUrl = `https://pc.ctyun.cn/static/common/${filename}.wasm`;
    await proxyStaticAsset(reply, targetUrl);
  });
  fastify.get('/static/common/:filename.wasm', async (request: FastifyRequest, reply: FastifyReply) => {
    const { filename } = request.params as { filename: string };
    const targetUrl = `https://pc.ctyun.cn/static/common/${filename}.wasm`;
    await proxyStaticAsset(reply, targetUrl);
  });

  // 5. 代理天翼云静态资源 (/ctyun-static/*) 与官方 CDN 资源
  fastify.get('/ctyun-static/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = request.raw.url || '';
    const relPath = rawUrl.replace(/^\/ctyun-static\//, '').replace(/^\/+/, '');
    // 优先从官方主站拉取，若包含 pccdnstatic/ 则从官方专用 CDN 拉取
    const targetUrl = relPath.startsWith('pccdnstatic/')
      ? `https://deskcdn.ctyun.cn/${relPath}`
      : `https://pc.ctyun.cn/${relPath}`;
    await proxyStaticAsset(reply, targetUrl);
  });

  // 6. 天翼云 API 反向代理通道 (流式管道，防盗链透传与全跨域开放)
  const proxyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAuth(request, reply)) return;
    const req = request.raw;
    const res = reply.raw;
    reply.hijack();

    // 放行 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const targetUrl = parsedUrl.searchParams.get('target');

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Missing target parameter' }));
      return;
    }

    let parsedTarget: URL;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid target URL' }));
      return;
    }

    // 安全防御：严格限制目标域名为天翼云官网域名 (*.ctyun.cn)，彻底杜绝 SSRF 任意内网/外部探测
    const hostname = parsedTarget.hostname.toLowerCase();
    const isAllowedHost = hostname === 'ctyun.cn' || hostname.endsWith('.ctyun.cn');
    if (!isAllowedHost) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Forbidden: only ctyun.cn domains are permitted' }));
      return;
    }

    // 广告/Banner、埋点与家庭业务非核心接口安全兜底 (消除 401 / 40011 / 400 签名与非法参数报错)
    if (parsedTarget.pathname.includes('/operation/banner') || parsedTarget.pathname.includes('/dataEvent/sendBatch')) {
      res.writeHead(200, {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: [] }));
      return;
    }

    if (parsedTarget.pathname.includes('listUserProperties')) {
      res.writeHead(200, {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: [] }));
      return;
    }

    if (parsedTarget.pathname.includes('checkIfObjsCanJoinGroup')) {
      res.writeHead(200, {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end(JSON.stringify({ code: 0, msg: 'ok', data: { canJoinGroup: false } }));
      return;
    }

    // 伪装 Origin 与 Referer，消除跨域与防盗链拦截
    const proxyHeaders: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'content-length') continue;
      proxyHeaders[k] = v;
    }
    proxyHeaders['host'] = parsedTarget.host;
    proxyHeaders['origin'] = 'https://pc.ctyun.cn';
    proxyHeaders['referer'] = 'https://pc.ctyun.cn/';

    // 获取 request.body (兼容 Buffer、字符串以及 Fastify 自动解析出的 JSON 对象/数组)
    let bodyBuffer: Buffer | null = null;
    if (Buffer.isBuffer(request.body)) {
      bodyBuffer = request.body;
    } else if (typeof request.body === 'string') {
      bodyBuffer = Buffer.from(request.body);
    } else if (request.body !== null && request.body !== undefined && typeof request.body === 'object') {
      bodyBuffer = Buffer.from(JSON.stringify(request.body));
    }

    if (bodyBuffer && bodyBuffer.length > 0) {
      proxyHeaders['content-length'] = bodyBuffer.length;
    }

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
        const responseHeaders: Record<string, any> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (k.toLowerCase() === 'set-cookie') continue;
          responseHeaders[k] = v;
        }
        responseHeaders['access-control-allow-origin'] = '*';
        responseHeaders['access-control-allow-credentials'] = 'true';
        responseHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        responseHeaders['access-control-allow-headers'] = '*';
        responseHeaders['access-control-expose-headers'] = '*';

        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Proxy Error: ${err.message}` }));
      }
    });

    if (bodyBuffer && bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  };

  fastify.all('/api/ctyun-proxy', proxyHandler);
}
