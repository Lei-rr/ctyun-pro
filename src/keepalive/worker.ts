import WebSocket from 'ws';
import { Protocol } from '../core/protocol.js';
import type { Desktop, DesktopInfo } from '../core/client.js';

export interface KeepAliveWorkerOptions {
  accountName: string;
  desktop: Desktop;
  desktopInfo: DesktopInfo;
  loginInfo: any;
  deviceCode: string;
  onRefreshInfo?: (desktopId: string) => Promise<DesktopInfo>;
  onStatusChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'stopped') => void;
  onHeartbeat?: () => void;
  onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void;
}

/**
 * 经典纯协议保活工作者 (后台静默保活模式)
 * 核心机制：
 * 1. 严格对齐官方长连接协议标准：
 *    单个 MAIN WebSocket + 30s 活跃心跳 (Type 7) + REDQ/103 响应
 * 2. 静默保活安全守则：仅响应保活心跳与握手，绝不发送独占性会话指令，
 *    使通道持续维持实例活跃并重置官方休眠计时器，官方客户端随时连入互不挤占。
 * 3. 监听 Type 119/120/137 与 4001 状态通知，感知真机用户上线
 * 4. 支持 pause() 与 resume() 软暂停/恢复，与挂机任务无缝优雅交接
 */
export class KeepAliveWorker {
  private options: KeepAliveWorkerOptions;
  private currentWs: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isReconnecting = false;
  private isPaused = false;

  constructor(options: KeepAliveWorkerOptions) {
    this.options = options;
  }

  private log(level: 'info' | 'warn' | 'error' | 'success', msg: string) {
    this.options.onLog?.(level, `[${this.options.accountName}][${this.options.desktop.desktopCode || this.options.desktop.desktopId}] ${msg}`);
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    this.isPaused = false;
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

  /**
   * 软暂停保活连接 (用于让位给挂机任务，不销毁配置)
   */
  public pause(): void {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.cleanupSocket();
    this.log('info', '保活通道已软暂停（让位给任务执行）');
  }

  /**
   * 恢复保活连接
   */
  public resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
    this.log('info', '任务完成，保活通道正在恢复连接...');
    this.connect();
  }

  private cleanupSocket(): void {
    if (this.currentWs) {
      try {
        this.currentWs.removeAllListeners();
        if (this.currentWs.readyState === WebSocket.OPEN || this.currentWs.readyState === WebSocket.CONNECTING) {
          this.currentWs.close(1000, 'Worker cleanup');
        }
      } catch {}
      this.currentWs = null;
    }
  }

  /** 发送官方 30s 活跃心跳 (Type 7) */
  private sendClientHeartbeat(): void {
    if (!this.isRunning || this.isPaused || !this.currentWs || this.currentWs.readyState !== WebSocket.OPEN) return;
    try {
      // CLINK_MSGC_HEARTBEAT = 7 (type: uint16=7, size: uint32=0)
      const hbBuf = Protocol.buildMessage(7);
      this.currentWs.send(hbBuf);
      this.log('info', '-> 发送客户端活跃心跳 (30s 心跳保活)');
      this.options.onHeartbeat?.();
    } catch (err: any) {
      this.log('warn', `发送客户端心跳异常: ${err.message}`);
    }
  }

  private connect(): void {
    if (!this.isRunning || this.isPaused) return;

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

    this.log('info', `建立云电脑长连接 (${desktopInfo.clinkLvsOutHost})...`);

    const ws = new WebSocket(mainUrl, ['binary'], {
      headers: {
        Origin: 'https://pc.ctyun.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      rejectUnauthorized: false,
    });
    this.currentWs = ws;

    const triggerReconnect = async (code: number, reason: any) => {
      if (!this.isRunning || this.isPaused || this.isReconnecting) return;
      this.isReconnecting = true;

      this.options.onStatusChange?.('reconnecting');
      const reasonStr = reason?.toString() || '';
      
      // 检测是否为官方客户端接入导致的避让
      if (code === 4001 || reasonStr.includes('preempt') || reasonStr.includes('conflict')) {
        this.log('info', `检测到客户端在线接入 (Code ${code})，通道主动避让，将在 5 分钟后恢复保活...`);
      } else {
        this.log('info', `网络连接断开 (${code}, ${reasonStr || '远程连接关闭'})，5秒后自动重连...`);
      }

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.cleanupSocket();

      // 断线重连前重新换取官方最新动态连接凭证
      if (this.options.onRefreshInfo) {
        try {
          const freshInfo = await this.options.onRefreshInfo(String(this.options.desktop.desktopId));
          this.options.desktopInfo = freshInfo;
        } catch {}
      }

      const retryDelay = (code === 4001 || reasonStr.includes('preempt')) ? 300000 : 5000;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, retryDelay);
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
        if (!this.isRunning || this.isPaused || ws.readyState !== WebSocket.OPEN) return;
        try {
          const initialPayload = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
          ws.send(initialPayload);
          this.log('success', '云电脑保活会话建立成功');
          this.options.onStatusChange?.('connected');

          // 3. 启动官方标准的 30s 活跃心跳定时器
          if (!this.heartbeatTimer) {
            this.heartbeatTimer = setInterval(() => this.sendClientHeartbeat(), 30000);
          }
        } catch (err: any) {
          this.log('error', `握手流程异常: ${err.message}`);
        }
      }, 500);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (!this.isRunning || this.isPaused) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      // 收到 REDQ 保活校验帧 -> 动态响应
      if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'REDQ') {
        try {
          const response = Protocol.executeRedqEncryption(buffer);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(response);
          }
        } catch (err: any) {
          this.log('warn', `处理保活校验异常: ${err.message}`);
        }
        return;
      }

      // 收到 Type 103 用户状态探测 -> 仅响应 Type 118 用户身份（后台静默保活，不抢占会话）
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

          // 监听官方客户端状态通知 (Type 119/120/137)
          if (info.type === 119 || info.type === 120 || info.type === 137) {
            this.log('info', `收到会话状态通知 (Type ${info.type})，保活通道正常维持`);
          }
        }
      } catch {}
    });

    ws.on('close', (code, reason) => triggerReconnect(code, reason));
    ws.on('error', (err) => this.log('error', `网络异常: ${err.message}`));
  }
}
