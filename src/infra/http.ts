import { globalApiGate } from './gate.js';

/**
 * 带超时与全局并发门禁的 fetch。
 * 所有对天翼云官方接口的调用都应经由此函数，避免多账号高并发触发官方频控。
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
