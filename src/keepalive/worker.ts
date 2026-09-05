import WebSocket from 'ws';
import { Protocol } from '../core/protocol.js';
import type { Desktop, DesktopInfo, LoginInfo } from '../core/client.js';

export interface KeepAliveWorkerOptions {
  accountName: string;
  desktop: Desktop;
  desktopInfo: DesktopInfo;
  loginInfo: LoginInfo;
  deviceCode: string;
  keepAliveSeconds?: number;
  onRefreshInfo?: (desktopId: string) => Promise<DesktopInfo>;
  onLog?: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void;
  onStatusChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'stopped') => void;
  onHeartbeat?: () => void;
}

/**
 * 经典极简纯保活工作者 (严格对齐 GitHub 经典实现：单个 MAIN WebSocket + 30s 活跃心跳 + REDQ/103 响应)
 */
export class KeepAliveWorker {
  private options: KeepAliveWorkerOptions;
  private isRunning = false;
  private isReconnecting = false;
  private currentWs: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: KeepAliveWorkerOptions) {
    this.options = {
      keepAliveSeconds: 30,
      ...options,
    };
  }

  private log(level: 'info' | 'warn' | 'error' | 'success', message: string) {
    const prefix = `[${this.options.accountName}][${this.options.desktop.desktopCode || this.options.desktop.desktopId}]`;
    this.options.onLog?.(level, `${prefix} ${message}`);
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('info', '保活任务启动：维持持久长连接与自动心跳校验');
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    this.isReconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.cleanupSocket();
    this.options.onStatusChange?.('stopped');
  }

  private cleanupSocket(): void {
    if (this.currentWs) {
      try {
        this.currentWs.removeAllListeners();
        this.currentWs.on('error', () => {});
        this.currentWs.close(1000, 'Worker Stopped');
      } catch {}
      this.currentWs = null;
    }
  }

  /** 发送官方 30s 活跃心跳 */
  private sendClientHeartbeat(): void {
    if (!this.isRunning || !this.currentWs || this.currentWs.readyState !== WebSocket.OPEN) return;
    try {
      // CLINK_MSGC_HEARTBEAT = 7 (type: uint16=7, size: uint32=0)
      const hbBuf = Buffer.from([0x07, 0x00, 0x00, 0x00, 0x00, 0x00]);
      this.currentWs.send(hbBuf);
      this.log('info', '-> 发送客户端活跃心跳 (30s 心跳保活)');
      this.options.onHeartbeat?.();
    } catch (err: any) {
      this.log('warn', `发送客户端心跳异常: ${err.message}`);
    }
  }

  private connect(): void {
    if (!this.isRunning) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.cleanupSocket();
    this.isReconnecting = false;
    this.options.onStatusChange?.('connecting');

    const { desktopInfo, desktop } = this.options;
    const hostParts = desktopInfo.clinkLvsOutHost.split(':');
    const mainUrl = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktop.desktopId}/MAIN`;

    this.log('info', `建立持久 WebSocket 连接 (${desktopInfo.clinkLvsOutHost})...`);

    const ws = new WebSocket(mainUrl, ['binary'], {
      headers: {
        Origin: 'https://pc.ctyun.cn',
      },
      rejectUnauthorized: false,
    });
    this.currentWs = ws;

    const triggerReconnect = async (code: number, reason: any) => {
      if (!this.isRunning || this.isReconnecting) return;
      this.isReconnecting = true;

      this.options.onStatusChange?.('reconnecting');
      this.log('info', `网络连接断开 (${code}, ${reason?.toString() || '远程连接关闭'})，5秒后自动重连...`);

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.cleanupSocket();

      // 断线重连前重新换取官方最新动态连接凭证与 Token
      if (this.options.onRefreshInfo) {
        try {
          const freshInfo = await this.options.onRefreshInfo(this.options.desktop.desktopId);
          this.options.desktopInfo = freshInfo;
        } catch {}
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 5000);
    };

    ws.on('open', async () => {
      this.log('success', 'WebSocket 连接就绪，发送握手配置...');

      // 1. 发送连接握手 JSON
      const connectMessage = {
        type: 1,
        ssl: 1,
        host: hostParts[0],
        port: hostParts.length > 1 ? hostParts[1] : '443',
        ca: desktopInfo.caCert,
        cert: desktopInfo.clientCert,
        key: desktopInfo.clientKey,
        servername: `${desktopInfo.host}:${desktopInfo.port}`,
        oqs: 0,
      };

      try {
        ws.send(JSON.stringify(connectMessage));
      } catch (err: any) {
        this.log('error', `发送连接配置失败: ${err.message}`);
        ws.close();
        return;
      }

      // 2. 等待 500ms 发送原生初始握手帧 (UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA)
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            const initialPayload = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
            ws.send(initialPayload);
            this.log('success', '进入保活监听状态');
            this.options.onStatusChange?.('connected');

            // 3. 启动官方标准的 30s 活跃心跳定时器
            if (!this.heartbeatTimer) {
              this.heartbeatTimer = setInterval(() => this.sendClientHeartbeat(), 30000);
            }
          } catch (err: any) {
            this.log('error', `握手流程异常: ${err.message}`);
          }
        }
      }, 500);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      // 收到 REDQ 保活校验帧 -> 动态解密并响应
      if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'REDQ') {
        this.log('info', '-> 收到服务端保活校验');
        try {
          const response = Protocol.executeRedqEncryption(buffer);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(response);
            this.log('success', '-> 发送保活校验响应成功');
          }
        } catch (err: any) {
          this.log('warn', `处理保活校验异常: ${err.message}`);
        }
        return;
      }

      // 收到 Type 103 用户状态探测 -> 响应 Type 118 用户身份
      try {
        const infos = Protocol.parseSendInfo(buffer);
        for (const info of infos) {
          if (info.type === 103) {
            const payload = JSON.stringify({
              type: 1,
              userName: this.options.loginInfo.userName,
              userInfo: '',
              userId: this.options.loginInfo.userId,
            });
            const byUserName = Protocol.buildSendInfoBuffer(118, Buffer.from(payload, 'utf-8'), true);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(byUserName);
            }
          }
        }
      } catch {}
    });

    ws.on('close', (code, reason) => triggerReconnect(code, reason));
    ws.on('error', (err) => this.log('error', `网络异常: ${err.message}`));
  }
}
