import https from 'node:https';
import { Readable } from 'node:stream';
import { globalApiGate } from './gate.js';

/** 官方专用网络接入点以 IP 直连下发，证书为 *.ctyun.cn 通配符；Node fetch 不带 SNI 会误报 ERR_TLS_CERT_ALTNAME_INVALID */
const IP_HOST_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IP_TLS_SERVERNAME = 'desk.ctyun.cn';

/** IP 直连请求：改用 https.request 显式设置 servername，行为与 fetch 对齐（string body / 超时 / abort） */
async function ipHostFetch(url: string | URL | Request, opts: RequestInit, signal: AbortSignal): Promise<Response> {
  const u = typeof url === 'string' ? new URL(url) : url instanceof URL ? url : new URL(url.url);
  const headers: Record<string, string> = {};
  new Headers(opts.headers).forEach((v, k) => (headers[k] = v));
  const body = typeof opts.body === 'string' || Buffer.isBuffer(opts.body) ? opts.body : undefined;
  if (body) headers['content-length'] = String(Buffer.byteLength(body as string | Buffer));

  const resp = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const req = https.request(
      {
        host: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        servername: IP_TLS_SERVERNAME,
      },
      resolve,
    );
    req.on('error', reject);
    signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    if (body) req.write(body);
    req.end();
  });

  const respHeaders = new Headers();
  for (let i = 0; i + 1 < resp.rawHeaders.length; i += 2) respHeaders.append(resp.rawHeaders[i], resp.rawHeaders[i + 1]);
  return new Response(Readable.toWeb(resp) as ReadableStream, { status: resp.statusCode || 502, headers: respHeaders });
}

/** 超时与外部 signal 联动：统一 AbortController 生命周期 */
function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 天翼云官方接口请求：全局并发门禁 + 超时。
 * 所有对官方接口的调用必须走此函数，避免多账号高并发触发官方频控。
 */
export async function safeFetch(
  url: string | URL | Request,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 60000, ...fetchOpts } = options;

  return globalApiGate.schedule(async () => {
    const t = withTimeout(fetchOpts.signal, timeoutMs);
    try {
      const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (IP_HOST_RE.test(new URL(target).hostname)) {
        return await ipHostFetch(url, fetchOpts, t.signal);
      }
      return await fetch(url, { ...fetchOpts, signal: t.signal });
    } finally {
      t.done();
    }
  });
}

/**
 * 第三方请求（Webhook 通知等）：仅超时，不占用官方接口门禁配额。
 */
export async function timedFetch(
  url: string | URL | Request,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const { timeoutMs = 10000, ...fetchOpts } = options;
  const t = withTimeout(fetchOpts.signal, timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: t.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    t.done();
  }
}

/**
 * 提取异常信息 (统一 unknown 异常处理)
 * Node fetch 的 TypeError('fetch failed') 会把真实原因放在 cause 中 (如 ECONNRESET/ENOTFOUND)，
 * 必须展开 cause 否则日志无法定位网络故障
 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) {
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      return `${err.message} (${code || cause.message})`;
    }
    if (typeof cause === 'object') {
      const c = cause as { code?: string; message?: string };
      const detail = c.code || c.message;
      if (detail) return `${err.message} (${detail})`;
    }
    if (typeof cause === 'string') return `${err.message} (${cause})`;
  }
  return err.message;
}
