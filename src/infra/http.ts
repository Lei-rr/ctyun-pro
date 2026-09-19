import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { globalApiGate } from './gate.js';
import { NotifyService } from './notify.js';

export interface Ipv4Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: () => Promise<string>;
  json: () => Promise<any>;
}

/**
 * 带超时保护与全局并发门禁的 fetch
 * 所有对天翼云官方接口的调用都应经过此函数，以受控并发避免触发频控
 */
export async function safeFetch(
  url: string | URL | Request,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 60000, ...fetchOpts } = options;

  return globalApiGate.schedule(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (fetchOpts.signal) fetchOpts.signal.addEventListener('abort', onAbort);

    try {
      return await fetch(url, { ...fetchOpts, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
      if (fetchOpts.signal) fetchOpts.signal.removeEventListener('abort', onAbort);
    }
  });
}

/**
 * 强制 IPv4 栈的底层 HTTPS 请求器 (规避容器 IPv6 路由不可达导致的挂起)
 * 同样受全局并发门禁约束，防止绕过限流
 */
export function requestIpv4(
  urlStr: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<Ipv4Response> {
  const url = new URL(urlStr);
  const timeoutMs = options.timeoutMs || 60000;

  return globalApiGate.schedule(
    () =>
      new Promise<Ipv4Response>((resolve, reject) => {
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
            res.setEncoding('utf8');
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              resolve({
                status: res.statusCode || 200,
                headers: res.headers,
                text: () => Promise.resolve(data),
                json: () => {
                  try {
                    return Promise.resolve(JSON.parse(data));
                  } catch {
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
      }),
  );
}

/** 原子化安全写入文件 (先写临时文件再 rename 替换) */
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

/** 提取异常信息 (统一 Unknown 异常处理) */
export function errorText(err: unknown): string {
  return errorText(err);
}

/** 统一消息推送入口 */
export async function sendWebhookNotification(
  webhookUrl: string | undefined,
  title: string,
  content: string,
): Promise<boolean> {
  return NotifyService.sendNotification(webhookUrl, title, content);
}

/** 获取东八区当天日期 (YYYY-MM-DD) */
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

/** 获取东八区标准时间 (YYYY-MM-DD HH:mm:ss) */
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
