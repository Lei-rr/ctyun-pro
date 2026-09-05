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
 * 单台云电脑 CLINK 最小三通道 (MAIN + DISPLAY + INPUTS) 保活工作者
 * 架构核心原则：
 * 1. MAIN 负责动态认证、登录信息、通道列表和 5 秒活跃心跳
 * 2. DISPLAY/INPUTS 只保留计费会话所需的最小通道
 * 3. 严格防并发重连锁，杜绝多实例同时连接冲突
 */
export class KeepAliveWorker {
  private options: KeepAliveWorkerOptions;
  private isRunning = false;
  private isReconnecting = false;
  private currentWs: WebSocket | null = null;
  private channelSockets = new Map<string, WebSocket>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private protocolStage: 'proxy' | 'link' | 'ticket' | 'ready' = 'proxy';
  private mainConnectionId = 0;
  private ackWindow = 0;
  private messagesUntilAck = 0;

  constructor(options: KeepAliveWorkerOptions) {
    this.options = {
      keepAliveSeconds: 60,
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
    this.cleanupSockets();
    this.resetProtocolState();
    this.options.onStatusChange?.('stopped');
    this.log('warn', '保活任务已停止');
  }

  private cleanupSockets(): void {
    if (this.currentWs) {
      try {
        const ws = this.currentWs;
        this.currentWs = null;
        ws.on('error', () => {});
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'Worker Stopped');
        }
      } catch {}
    }
    for (const ws of this.channelSockets.values()) {
      try {
        ws.on('error', () => {});
        ws.close(1000, 'Worker Stopped');
      } catch {}
    }
    this.channelSockets.clear();
  }

  private resetProtocolState(): void {
    this.receiveBuffer = Buffer.alloc(0);
    this.protocolStage = 'proxy';
    this.mainConnectionId = 0;
    this.ackWindow = 0;
    this.messagesUntilAck = 0;
  }

  private buildChannelHeader(connectionId: number, channelType: number, channelId: number): Buffer {
    const caps = channelType === 2
      ? (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8) | (1 << 11) | (1 << 12) | (1 << 14) | (1 << 19) | (1 << 23) | (1 << 27)
      : 0;
    const result = Buffer.alloc(42);
    result.write('REDQ', 0, 'ascii');
    result.writeUInt32LE(2, 4);
    result.writeUInt32LE(2, 8);
    result.writeUInt32LE(26, 12);
    result.writeUInt32LE(connectionId, 16);
    result.writeUInt8(channelType, 20);
    result.writeUInt8(channelId, 21);
    result.writeUInt32LE(1, 22);
    result.writeUInt32LE(1, 26);
    result.writeUInt32LE(18, 30);
    result.writeUInt32LE(9, 34);
    result.writeUInt32LE(caps, 38);
    return result;
  }

  private startChannel(
    channelType: number,
    channelId: number,
    connectionId: number,
    desktopInfo: DesktopInfo,
    desktopId: string,
    hostParts: string[],
  ): void {
    if (channelType !== 2 && channelType !== 3) return;
    const name = channelType === 2 ? 'DISPLAY' : 'INPUTS';
    if (this.channelSockets.has(name)) return;
    const url = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktopId}/${name}`;
    const ws = new WebSocket(url, ['binary'], {
      headers: { Origin: 'https://pc.ctyun.cn' },
      rejectUnauthorized: false,
    });
    this.channelSockets.set(name, ws);
    let stage: 'proxy' | 'link' | 'ticket' | 'ready' = 'proxy';
    let receiveBuffer = Buffer.alloc(0);
    ws.on('open', () => ws.send(JSON.stringify({
      type: channelType,
      ssl: 1,
      host: hostParts[0],
      port: hostParts.length > 1 ? hostParts[1] : '443',
      ca: desktopInfo.caCert,
      cert: desktopInfo.clientCert,
      key: desktopInfo.clientKey,
      servername: `${desktopInfo.host}:${desktopInfo.port}`,
      oqs: 0,
    })));
    ws.on('message', (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (stage === 'proxy' && buffer.length === 1 && buffer[0] === 1) {
        ws.send(this.buildChannelHeader(connectionId, channelType, channelId));
        stage = 'link';
        return;
      }
      if (stage === 'link' && buffer.length >= 182 && buffer.subarray(0, 4).toString('ascii') === 'REDQ') {
        try {
          ws.send(Protocol.buildClinkTicket(buffer));
          stage = 'ticket';
        } catch (error: any) {
          this.log('error', `${name} 公钥处理失败: ${error.message}`);
          ws.close();
        }
        return;
      }
      if (stage === 'ticket' && buffer.length === 4) {
        if (buffer.readUInt32LE(0) !== 0) {
          this.log('warn', `${name} CLINK 认证失败 (${buffer.readUInt32LE(0)})`);
          ws.close();
          return;
        }
        stage = 'ready';
        this.log('success', `${name} CLINK 动态认证成功`);
        if (channelType === 2) {
          // DISPLAY_SETTING payload: mode=ADAPTION, image fps=12, 32-bit,
          // stream fps=24, quality=BEST.
          const setting = Buffer.from([108, 0, 5, 0, 0, 0, 2, 12, 4, 24, 3]);
          const init = Buffer.alloc(20);
          init.writeUInt16LE(101, 0);
          init.writeUInt32LE(14, 2);
          init.writeUInt8(1, 6);
          init.writeBigUInt64LE(10485760n, 7);
          ws.send(setting);
          ws.send(init);
        }
        return;
      }
      if (stage !== 'ready') return;
        receiveBuffer = Buffer.concat([receiveBuffer, buffer]);
        while (receiveBuffer.length >= 6) {
          const size = receiveBuffer.readUInt32LE(2);
          if (size > 64 * 1024 * 1024 || receiveBuffer.length < size + 6) return;
          const message = receiveBuffer.subarray(0, size + 6);
          this.handleControlMessage(ws, message);
          receiveBuffer = receiveBuffer.subarray(size + 6);
        }
    });
    ws.on('error', (err) => this.log('warn', `${name} 网络异常: ${err.message}`));
    ws.on('close', () => this.channelSockets.delete(name));
  }

  private handleControlMessage(ws: WebSocket, message: Buffer): void {
    const type = message.readUInt16LE(0);
    const data = message.subarray(6);
    if (type === 4) {
      const pong = Buffer.alloc(6 + Math.min(data.length, 12));
      pong.writeUInt16LE(3, 0);
      pong.writeUInt32LE(pong.length - 6, 2);
      data.copy(pong, 6, 0, pong.length - 6);
      ws.send(pong);
    } else if (type === 9) {
      ws.send(Protocol.buildMessage(7));
      this.options.onHeartbeat?.();
    } else if (type === 3 && data.length >= 8) {
      this.ackWindow = data.readUInt32LE(4);
      this.messagesUntilAck = this.ackWindow;
    } else if (this.ackWindow > 0 && type !== 1) {
      this.messagesUntilAck--;
      if (this.messagesUntilAck <= 0) {
        const ack = Buffer.alloc(10);
        ack.writeUInt16LE(1, 0);
        ack.writeUInt32LE(4, 2);
        ack.writeUInt32LE(data.length >= 4 ? data.readUInt32LE(0) : 0, 6);
        ws.send(ack);
        this.messagesUntilAck = this.ackWindow;
      }
    }
  }

   /** MAIN 使用 5 秒活跃心跳；通用 CLINK 通道默认周期不是 MAIN 周期。 */
  private sendClientHeartbeat(): void {
    if (!this.isRunning || !this.currentWs || this.currentWs.readyState !== WebSocket.OPEN) return;
    try {
      const hbBuf = Buffer.from([0x07, 0x00, 0x00, 0x00, 0x00, 0x00]);
      this.currentWs.send(hbBuf);
      this.log('info', '-> 发送 MAIN 活跃心跳 (5 秒)');
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

    this.cleanupSockets();
    this.resetProtocolState();
    this.isReconnecting = false;
    this.options.onStatusChange?.('connecting');

    const { desktopInfo, desktop } = this.options;
    const hostParts = desktopInfo.clinkLvsOutHost.split(':');
    const mainUrl = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${desktop.desktopId}/MAIN`;

    this.log('info', `建立持久 WebSocket 连接 (${desktopInfo.clinkLvsOutHost})...`);

    // 1. 建立 MAIN 主控信道
    const wsMain = new WebSocket(mainUrl, ['binary'], {
      headers: { Origin: 'https://pc.ctyun.cn' },
      rejectUnauthorized: false,
    });
    this.currentWs = wsMain;

    const sendMain = (message: Buffer | string): boolean => {
      if (wsMain.readyState !== WebSocket.OPEN) return false;
      try {
        wsMain.send(message);
        return true;
      } catch (error: any) {
        this.log('warn', `MAIN 发送失败: ${error.message}`);
        return false;
      }
    };

    const triggerMainReconnect = async (code: number, reason: any) => {
      if (!this.isRunning || this.isReconnecting) return;
      // 检查挂机任务是否正在执行，若有挂机任务在运行，当前会话断开系挂机端独占接管，不进行报警重连
      this.isReconnecting = true;

      this.options.onStatusChange?.('reconnecting');
      this.log('warn', `[MAIN] 连接断开 (${code}, ${reason?.toString() || '远程连接关闭'})，5秒后重新换取最新凭证并平滑重连...`);

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.cleanupSockets();

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

    // --- MAIN 信道处理 ---
    wsMain.on('open', async () => {
      this.options.onStatusChange?.('connected');
      this.log('success', 'MAIN 信令连接就绪，发送握手配置...');

      try {
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
        wsMain.send(JSON.stringify(connectMessage));

      } catch (err: any) {
        this.log('error', `MAIN 握手流程异常: ${err.message}`);
      }
    });

    wsMain.on('message', (data: WebSocket.RawData) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buffer.length === 0) return;
      if (this.protocolStage === 'proxy' && buffer.length === 1 && buffer[0] === 1) {
        sendMain(Protocol.buildClinkHeader());
        this.protocolStage = 'link';
        this.log('info', 'CLINK 代理已就绪，发送 MAIN 协议头');
        return;
      }
      if (this.protocolStage === 'link' && buffer.length >= 182 && buffer.subarray(0, 4).toString('ascii') === 'REDQ') {
        try {
          sendMain(Protocol.buildClinkTicket(buffer));
          this.protocolStage = 'ticket';
        } catch (error: any) {
          this.log('error', `CLINK MAIN 公钥处理失败: ${error.message}`);
          wsMain.close();
        }
        return;
      }
      if (this.protocolStage === 'ticket' && buffer.length === 4) {
        const code = buffer.readUInt32LE(0);
        if (code !== 0) {
          this.log('error', `CLINK 认证失败 (${code})`);
          wsMain.close();
          return;
        }
        this.protocolStage = 'ready';
        this.receiveBuffer = Buffer.alloc(0);
        this.log('success', 'CLINK MAIN 动态认证成功');
        if (!this.heartbeatTimer) {
          this.heartbeatTimer = setInterval(() => this.sendClientHeartbeat(), 5000);
        }
        return;
      }
      if (this.protocolStage !== 'ready') return;
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, buffer]);
      while (this.receiveBuffer.length >= 6) {
        const size = this.receiveBuffer.readUInt32LE(2);
        if (size > 64 * 1024 * 1024) throw new Error(`CLINK 消息过大 (${size})`);
        if (this.receiveBuffer.length < 6 + size) break;
        const message = this.receiveBuffer.subarray(0, 6 + size);
        this.receiveBuffer = this.receiveBuffer.subarray(6 + size);
        const type = message.readUInt16LE(0);
        if (type === 103) {
          this.mainConnectionId = message.length >= 10 ? message.readUInt32LE(6) : 0;
          sendMain(Protocol.buildClientUserName(this.options.loginInfo.userName, this.options.loginInfo.userId));
          sendMain(Protocol.buildMainClientLoginInfo(
            desktop.desktopId,
            desktopInfo.token,
            String(this.options.loginInfo.deviceType || '60'),
            this.options.deviceCode,
            this.options.loginInfo.userAccount || this.options.loginInfo.userName,
          ));
          sendMain(Protocol.buildMessage(116));
          sendMain(Protocol.buildMessage(104));
        } else if (type === 104) {
          const data = message.subarray(6);
          if (data.length >= 4) {
            const count = data.readUInt32LE(0);
            for (let i = 0; i < count; i++) {
              const offset = 4 + i * 2;
              if (offset + 2 <= data.length) {
                const channelType = data[offset];
                if (channelType === 2 || channelType === 3) {
                  this.startChannel(channelType, data[offset + 1], this.mainConnectionId, desktopInfo, desktop.desktopId, hostParts);
                }
              }
            }
          }
        }
      }
    });

    wsMain.on('close', (code, reason) => triggerMainReconnect(code, reason));
    wsMain.on('error', (err) => this.log('error', `MAIN 网络异常: ${err.message}`));
  }
}
