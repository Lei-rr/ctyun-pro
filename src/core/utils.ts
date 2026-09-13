import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

/**
 * 带有超时保护的安全 fetch (默认 60s 超时，防止官方接口异常导致整个事件循环挂起)
 */
export async function safeFetch(url: string | URL | Request, options: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 60000, ...fetchOpts } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // 若外部已提供 signal，进行联动
  const onAbort = () => controller.abort();
  if (fetchOpts.signal) {
    fetchOpts.signal.addEventListener('abort', onAbort);
  }

  try {
    const res = await fetch(url, {
      ...fetchOpts,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
    if (fetchOpts.signal) {
      fetchOpts.signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * 强制 IPv4 栈的底层 HTTPS 请求器 (解决部分容器与宿主机 IPv6 路由无响应挂起问题)
 */
export function requestIpv4(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; headers: Record<string, any>; text: () => Promise<string>; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const timeoutMs = options.timeoutMs || 60000;
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        family: 4,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 200,
            headers: res.headers,
            text: () => Promise.resolve(data),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(data));
              } catch (e) {
                return Promise.resolve(data);
              }
            },
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (${timeoutMs}ms): ${urlStr}`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 原子化安全写入文件 (先写临时文件再 rename 替换，防止崩溃断电导致文件空洞损坏)
 */
export function safeWriteFileSync(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

/**
 * 通用 Webhook 消息通知推送器 (支持 Server酱, Bark, 企业微信, 飞书, 钉钉, 自定义 Webhook)
 */
export async function sendWebhookNotification(
  webhookUrl: string | undefined,
  title: string,
  content: string
): Promise<boolean> {
  if (!webhookUrl || !webhookUrl.trim()) return false;
  const url = webhookUrl.trim();

  try {
    // 1. Bark 推送格式
    if (url.includes('day.app') || url.includes('/bark')) {
      const barkUrl = url.endsWith('/') ? url : `${url}/`;
      await safeFetch(`${barkUrl}${encodeURIComponent(title)}/${encodeURIComponent(content)}`, {
        method: 'GET',
        timeoutMs: 8000,
      });
      return true;
    }

    // 2. PushPlus (pushplus.plus)
    if (url.includes('pushplus.plus')) {
      await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          content: content.replace(/\n/g, '<br/>'),
          template: 'html',
        }),
        timeoutMs: 8000,
      });
      return true;
    }

    // 3. Server 酱 / pushdeer (支持 title / desp)
    if (url.includes('serverchan') || url.includes('sctapi.ftqq.com') || url.includes('pushdeer')) {
      await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          desp: content,
          text: title,
        }),
        timeoutMs: 8000,
      });
      return true;
    }

    // 3. 企业微信 Webhook
    if (url.includes('qyapi.weixin.qq.com')) {
      await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: {
            content: `【${title}】\n${content}`,
          },
        }),
        timeoutMs: 8000,
      });
      return true;
    }

    // 4. 飞书机器人 Webhook
    if (url.includes('open.feishu.cn')) {
      await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'text',
          content: {
            text: `【${title}】\n${content}`,
          },
        }),
        timeoutMs: 8000,
      });
      return true;
    }

    // 5. 钉钉机器人 Webhook
    if (url.includes('oapi.dingtalk.com')) {
      await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: {
            content: `【${title}】\n${content}`,
          },
        }),
        timeoutMs: 8000,
      });
      return true;
    }

    // 6. 默认通用 JSON POST Webhook
    await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'ctyun_alert',
        title,
        content,
        timestamp: Date.now(),
        time: getCstDateTimeString(),
      }),
      timeoutMs: 8000,
    });
    return true;
  } catch (err: any) {
    console.error(`[Webhook] 推送失败 (${url}):`, err.message);
    return false;
  }
}

export function getCstHour(date: Date = new Date()): number {
  const hourStr = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    hour12: false,
  }).format(date);
  return parseInt(hourStr, 10);
}

/**
 * 获取东八区北京时间当天日期字符串 (YYYY-MM-DD)
 */
export function getCstDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replace(/\//g, '-');
}

/**
 * 获取东八区北京时间标准时间字符串 (YYYY-MM-DD HH:mm:ss)
 */
export function getCstDateTimeString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
