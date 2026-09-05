import https from 'node:https';
import type { CtYunClient } from '../core/client.js';
import { safeFetch } from '../core/utils.js';

function requestIpv4(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; headers: Record<string, any>; json: () => Promise<any> }> {
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
 * 天翼云智助手 (eaichat) 独立任务处理器
 * 纯协议对接 CAS 单点认证链与大模型问答接口，达成「与AI对话1次」(+100积分)
 */
export class AiChatTask {
  public static async execute(client: CtYunClient): Promise<{ success: boolean; message: string }> {
    if (!client.loginInfo) {
      return { success: false, message: '未登录无法执行AI对话' };
    }

    try {
      // 1. 换取 eaichat 单点登录 Ticket
      const serviceUrl = 'https://eaichat.ctyun.cn:443/chat/#/aichat';
      const ticketUrl = `${client.baseUrl}/api/auth/client/getTicket?service=${encodeURIComponent(serviceUrl)}`;
      const tRes = await safeFetch(ticketUrl, { headers: client.getHeaders() });
      const tJson = (await tRes.json()) as { code: number; data?: { ticket?: string } };
      const ticket = tJson.data?.ticket;

      if (!ticket) {
        return { success: false, message: '获取AI网关认证凭证失败' };
      }

      // 2. 向 eaichat 网关兑换 SSO 会话凭据与 Cookie (强制 IPv4 连接)
      const authUrl = 'https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize';
      const authParams = new URLSearchParams();
      authParams.append('loginType', 'iamTicket');
      authParams.append('clientId', 'eaiapp');
      authParams.append('iamTicket', ticket);
      authParams.append('redirectUri', serviceUrl);

      const authRes = await requestIpv4(authUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://eaichat.ctyun.cn/chat/',
        },
        body: authParams.toString(),
      });

      const rawCookies = authRes.headers['set-cookie'] || [];
      const setCookies = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
      const cookieHeader = setCookies
        .map((c: string) => c.split(';')[0])
        .filter((c: string) => c.includes('='))
        .join('; ');

      // 3. 调用 AI 对话接口触发官方交互事件
      const chatUrl = 'https://eaichat.ctyun.cn/ai/portal/v3/openai/chat/completions';
      const chatBody = {
        messages: [{ role: 'user', content: '今天天气怎么样？' }],
        stream: false,
        client_retry: true,
        web_search: false,
        tenantId: client.loginInfo.tenantId,
      };

      const chatRes = await requestIpv4(chatUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          Referer: 'https://eaichat.ctyun.cn/chat/',
        },
        body: JSON.stringify(chatBody),
      });

      if (chatRes.status < 200 || chatRes.status >= 300) {
        return { success: false, message: `AI对话接口失败 (HTTP ${chatRes.status})` };
      }

      return { success: true, message: '已完成官方AI对话交互 (+100积分)' };
    } catch (err: any) {
      return { success: false, message: `AI对话交互异常: ${err.message}` };
    }
  }
}
