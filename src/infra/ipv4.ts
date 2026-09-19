import http from 'node:http';
import https from 'node:https';
import { globalApiGate } from './gate.js';

/**
 * 强制 IPv4 栈的底层 HTTP(S) 请求器。
 * 云厂商容器常无 IPv6 路由，Node fetch 可能优先 AAAA 导致挂起，故统一使用 family:4。
 * 受全局门禁约束，防止绕过限流。
 */
export interface Ipv4Options {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** 文本响应（JSON / HTML / 表单接口） */
export function requestIpv4(
  urlStr: string,
  options: Ipv4Options = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: () => Promise<string>;
  json: () => Promise<any>;
}> {
  return requestBufferIpv4(urlStr, options).then((res) => {
    const text = res.buffer.toString('utf8');
    return {
      status: res.status,
      headers: res.headers,
      text: () => Promise.resolve(text),
      json: () => {
        try {
          return Promise.resolve(JSON.parse(text));
        } catch {
          return Promise.resolve(text);
        }
      },
    };
  });
}

/** 二进制响应（静态资源 / 图片 / wasm），必须保留原始字节 */
export function requestBufferIpv4(
  urlStr: string,
  options: Ipv4Options = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  contentType: string;
  buffer: Buffer;
}> {
  const url = new URL(urlStr);
  const timeoutMs = options.timeoutMs || 60000;
  const clientModule = url.protocol === 'https:' ? https : http;

  return globalApiGate.schedule(
    () =>
      new Promise((resolve, reject) => {
        const req = clientModule.request(
          {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            family: 4,
            rejectUnauthorized: false,
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on('end', () => {
              resolve({
                status: res.statusCode || 200,
                headers: res.headers,
                contentType: (res.headers['content-type'] as string) || 'application/octet-stream',
                buffer: Buffer.concat(chunks),
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
