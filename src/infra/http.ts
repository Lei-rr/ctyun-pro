import { globalApiGate } from './gate.js';

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
