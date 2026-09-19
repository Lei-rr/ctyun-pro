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

/** 提取异常信息 (统一 unknown 异常处理) */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
