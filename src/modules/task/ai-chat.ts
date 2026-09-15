import crypto from 'crypto';
import type { CtYunClient } from '../../core/client.js';
import { safeFetch, requestIpv4 } from '../../core/utils.js';
import type { Logger } from '../../core/logger.js';

const PRESET_MESSAGES = [
  '今天北京天气怎么样？（请用一句话回答）',
  '给我讲一个冷笑话。（简短回答）',
  '来一首唐诗。（简短回答）',
  '空腹可以吃饭吗？（幽默简短回答）',
  '推荐一部经典的科幻电影。（简明扼要）',
  '人工智能未来发展趋势是什么？（简明扼要）',
  '怎样保持良好的身心健康？（简短回答）',
  '请用一句话分享今天的正能量心情。',
];

/**
 * 天翼云智助手 (eaichat) 独立任务处理器
 * 纯协议对接 CAS 单点认证链与大模型问答接口，达成「与AI对话1次」(+100积分)
 */
export class AiChatTask {
  public static async execute(
    client: CtYunClient,
    logger?: Logger,
  ): Promise<{ success: boolean; message: string }> {
    if (!client.loginInfo) {
      return { success: false, message: '未登录无法执行AI对话' };
    }

    try {
      // 1. 获取网关信息并解密 SSO RSA 公钥配置 (强制 IPv4 连接)
      const sysRes = await requestIpv4('https://gwyilian.ctyun.cn/server/eaiSysInfo', {
        method: 'GET',
        timeoutMs: 10000,
      });
      const sysJson = await sysRes.json();
      const rawSys = ((sysJson && sysJson.data) || '').replace(/[\r\n]/g, '');
      if (!rawSys) {
        return { success: false, message: '未能从网关提取到有效的 SSO 配置数据' };
      }

      const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('chinatelecom@cnn', 'utf8'), null);
      let dec = decipher.update(rawSys, 'base64', 'utf8');
      dec += decipher.final('utf8');
      const gatewayInfo = JSON.parse(dec);
      const ssopk = gatewayInfo.sso?.ssopk;
      const ssopkid = gatewayInfo.sso?.ssopkid;

      if (!ssopk) {
        return { success: false, message: '未能从网关提取到有效的 SSO RSA 公钥' };
      }

      // 2. 换取 eaichat 单点登录 Ticket
      const serviceUrl = 'https://eaichat.ctyun.cn:443/chat/#/aichat';
      const ticketUrl = `${client.baseUrl}/api/auth/client/getTicket?service=${encodeURIComponent(serviceUrl)}`;
      const ticketRes = await safeFetch(ticketUrl, { headers: client.getHeaders() });
      const ticketJson = (await ticketRes.json()) as { code?: number; data?: { ticket?: string }; msg?: string };
      const ticket = ticketJson.data?.ticket;

      if (!ticket) {
        return { success: false, message: `获取 CAS Ticket 失败: ${ticketJson.msg || JSON.stringify(ticketJson)}` };
      }

      // 3. 生成 16 字节随机密钥并通过 RSA-PKCS1 加密提交 SSO 授权
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let clientKey = '';
      for (let i = 0; i < 16; i++) clientKey += chars[Math.floor(Math.random() * chars.length)];
      const pem = `-----BEGIN PUBLIC KEY-----\n${ssopk}\n-----END PUBLIC KEY-----`;
      const encClientKey = crypto
        .publicEncrypt(
          { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
          Buffer.from(clientKey, 'utf8'),
        )
        .toString('hex');

      const authParams = new URLSearchParams();
      authParams.append('loginType', 'iamTicket');
      authParams.append('clientId', 'eaiapp');
      authParams.append('iamTicket', ticket);
      authParams.append('redirectUri', serviceUrl);
      authParams.append('clientKey', encClientKey);
      authParams.append('clientKeyId', ssopkid || '');

      const authPostRes = await requestIpv4('https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize', {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          Referer: 'https://eaichat.ctyun.cn/chat/',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: authParams.toString(),
        timeoutMs: 15000,
      });

      const authJson = await authPostRes.json();
      if (authJson.resultCode !== 0 && authJson.resultCode !== '0') {
        return { success: false, message: `SSO Ticket 鉴权换取失败: ${authJson.resultMsg || JSON.stringify(authJson)}` };
      }
      if (!authJson.data?.sessionKey) {
        return { success: false, message: 'SSO 鉴权响应中未包含 sessionKey' };
      }

      // 提取 Cookie
      const rawCookies = authPostRes.headers['set-cookie'] || [];
      const cookieStr = Array.isArray(rawCookies) ? rawCookies.join('; ') : String(rawCookies || '');
      const ylTokenMatch = cookieStr.match(/YL-Token=([^;]+)/);
      const ylSsidMatch = cookieStr.match(/YL-Ssid=([^;]+)/);
      const ylToken = ylTokenMatch ? ylTokenMatch[1] : (authPostRes.headers['yl-authorization'] || '');
      const ylSsid = ylSsidMatch ? ylSsidMatch[1] : '';
      const cookieHeader = `YL-Token=${ylToken}; YL-Ssid=${ylSsid}`;

      // 使用 clientKey 通过 AES-128-ECB 解密 sessionKey 得到 sk
      const decipherSk = crypto.createDecipheriv('aes-128-ecb', Buffer.from(clientKey, 'utf8'), null);
      let sk = decipherSk.update(authJson.data.sessionKey, 'base64', 'utf8');
      sk += decipherSk.final('utf8');

      // 4. 发送 AI 对话请求并完成官方 Web-Signature 计算
      const prompt = PRESET_MESSAGES[Math.floor(Math.random() * PRESET_MESSAGES.length)];
      const chatBody = {
        key_model: 'telechat',
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        client_retry: true,
        web_search: false,
      };
      const bodyJsonStr = JSON.stringify(chatBody);
      const dataMd5 = crypto.createHash('md5').update(bodyJsonStr, 'utf8').digest('hex').toLowerCase();
      const ts = Date.now().toString();
      let rnd = '';
      for (let i = 0; i < 8; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
      const rawSign = `${dataMd5}&${sk}&${ts}&${rnd}`;
      const webSign = crypto.createHash('sha256').update(rawSign, 'utf8').digest('hex').toLowerCase();
      const traceId = crypto.randomUUID();

      const chatRes = await requestIpv4('https://eaichat.ctyun.cn/ai/portal/v3/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          'YL-Authorization': ylToken,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          Referer: 'https://eaichat.ctyun.cn/chat/',
          Origin: 'https://eaichat.ctyun.cn',
          'x-client-trace-id': traceId,
          'x-eai-source': 'web-eai',
          'x-eai-version': '202060305',
          'YL-Main-Version': '202060305',
          'YL-Product-Id': '5',
          'Web-Signature': webSign,
          'Web-Random': rnd,
          'Web-Timestamp': ts,
        },
        body: bodyJsonStr,
        timeoutMs: 15000,
      });

      if (chatRes.status < 200 || chatRes.status >= 300) {
        return { success: false, message: `AI对话接口异常 (HTTP ${chatRes.status})` };
      }

      return { success: true, message: `官方AI对话已成功完成 (提示词: "${prompt}")` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `AI对话交互异常: ${msg}` };
    }
  }
}
