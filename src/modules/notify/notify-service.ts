import { getCstDateTimeString } from '../../core/utils.js';

export interface NotificationPayload {
  title: string;
  content: string;
  level?: 'info' | 'warn' | 'error' | 'success';
  timestamp?: number;
}

/**
 * 安全的 HTTP 请求客户端 (带超时控制)
 */
export async function safeFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }> {
  const { timeoutMs = 10000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一通知推送模块
 * 支持：Bark、Server酱、企业微信、飞书、钉钉、Telegram、通用标准 JSON Webhook
 */
export class NotifyService {
  /**
   * 格式化消息标题与内容，移除 emoji 并规范化前缀
   */
  public static formatMessage(title: string, content: string): { title: string; content: string } {
    const cleanTitle = title.replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[✅✔✓⚠️❌❗]/gu, '').trim();
    const cleanContent = content.replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[✅✔✓⚠️❌❗]/gu, '').trim();
    return {
      title: cleanTitle || 'CTYUN-PRO 系统通知',
      content: cleanContent,
    };
  }

  /**
   * 发送 Webhook 通知
   */
  public static async sendNotification(
    webhookUrl: string | undefined | null,
    title: string,
    content: string,
  ): Promise<boolean> {
    if (!webhookUrl || !webhookUrl.trim()) return false;
    const url = webhookUrl.trim();
    const formatted = this.formatMessage(title, content);

    try {
      // 1. Bark (iOS)
      if (url.includes('api.day.app') || url.includes('/bark')) {
        const encTitle = encodeURIComponent(formatted.title);
        const encBody = encodeURIComponent(formatted.content);
        const barkUrl = url.endsWith('/')
          ? `${url}${encTitle}/${encBody}`
          : `${url}/${encTitle}/${encBody}`;
        const res = await safeFetch(barkUrl, { method: 'GET', timeoutMs: 8000 });
        return res.ok;
      }

      // 2. Server 酱 (sctapi.ftqq.com)
      if (url.includes('ftqq.com')) {
        await safeFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `title=${encodeURIComponent(formatted.title)}&desp=${encodeURIComponent(formatted.content)}`,
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
              content: `【${formatted.title}】\n${formatted.content}`,
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
              text: `【${formatted.title}】\n${formatted.content}`,
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
              content: `【${formatted.title}】\n${formatted.content}`,
            },
          }),
          timeoutMs: 8000,
        });
        return true;
      }

      // 6. Telegram Bot 推送
      if (url.includes('api.telegram.org') || url.includes('/sendMessage')) {
        let chatId = '';
        try {
          const u = new URL(url);
          chatId = u.searchParams.get('chat_id') || '';
        } catch {}

        if (chatId) {
          await safeFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `*${formatted.title}*\n\n${formatted.content}`,
              parse_mode: 'Markdown',
            }),
            timeoutMs: 8000,
          });
          return true;
        }
      }

      // 7. 默认通用 JSON POST Webhook
      await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'ctyun_alert',
          title: formatted.title,
          content: formatted.content,
          timestamp: Date.now(),
          time: getCstDateTimeString(),
        }),
        timeoutMs: 8000,
      });
      return true;
    } catch (err) {
      return false;
    }
  }
}
