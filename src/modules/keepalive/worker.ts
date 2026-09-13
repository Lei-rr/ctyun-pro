import WebSocket from 'ws';
import { Protocol } from '../../core/protocol.js';
import type { Desktop, DesktopInfo } from '../../core/client.js';
import { DesktopSessionArbiter } from '../arbiter/desktop-session-arbiter.js';

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
  private yieldClearedHandler: ((data: { desktopId: string }) => void) | null = null;

  constructor(options: KeepAliveWorkerOptions) {
    this.options = options;
  }

  private get logPrefix(): string {
    const d = this.options.desktop;
    const dName = d?.desktopName || (d as any)?.computerName || (d as any)?.name || d?.desktopCode || d?.desktopId || '';
    return dName ? `${this.options.accountName} - ${dName}` : this.options.accountName;
  }

  private log(level: 'info' | 'warn' | 'error' | 'success', msg: string) {
    this.options.onLog?.(level, `[${this.logPrefix}] ${msg}`);
  }

  private bindYieldCleared(): void {
    if (this.yieldClearedHandler) return;
    const dId = String(this.options.desktop.desktopId);
    this.yieldClearedHandler = ({ desktopId }) => {
      if (String(desktopId) === dId && this.isRunning && !this.isPaused) {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.isReconnecting = false;
        this.log('info', '外部客户端避让期已解除，立即尝试恢复保活长连接');
        this.connect();
      }
    };
    DesktopSessionArbiter.getInstance().on('yield:cleared', this.yieldClearedHandler);
  }

  private unbindYieldCleared(): void {
    if (this.yieldClearedHandler) {
      DesktopSessionArbiter.getInstance().off('yield:cleared', this.yieldClearedHandler);
      this.yieldClearedHandler = null;
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.bindYieldCleared();
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    this.isPaused = false;
    this.unbindYieldCleared();
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
      this.log('info', '发送客户端活跃心跳 (30s 心跳保活)');
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

    const dId = String(this.options.desktop.desktopId);
    const yieldStatus = DesktopSessionArbiter.getInstance().getYieldStatus(dId);
    if (yieldStatus.yielding) {
      this.log(
        'info',
        `桌面处于外部官方客户端主动避让期 (剩余 ${yieldStatus.remainingSeconds}秒)，暂缓建立长连接`,
      );
      this.isReconnecting = true;
      this.options.onStatusChange?.('reconnecting');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.isReconnecting = false;
        this.connect();
      }, Math.max(1000, yieldStatus.remainingSeconds * 1000));
      return;
    }

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
      handshakeTimeout: 15000,
    });
    this.currentWs = ws;

    const triggerReconnect = async (code: number, reason: any) => {
      if (!this.isRunning || this.isPaused || this.isReconnecting) return;
      this.isReconnecting = true;

      this.options.onStatusChange?.('reconnecting');
      const reasonStr = reason?.toString() || '';
      
      const isConflict = code === 4001 || reasonStr.includes('preempt') || reasonStr.includes('conflict');
      if (isConflict) {
        this.log('warn', `检测到云电脑已被外部官方客户端接入 (Code ${code})，系统主动避让 5 分钟，暂停长连接保活`);
        await DesktopSessionArbiter.getInstance().yieldToExternal(dId, 5, `网关通知外部客户端接入 (Code ${code})`);
      } else {
        this.log('info', `网络连接断开 (${code}, ${reasonStr || '远程连接关闭'})，5秒后自动重连...`);
      }

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.cleanupSocket();

      const retryDelay = isConflict ? 300000 : 5000;
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null;
        this.isReconnecting = false;
        if (!this.isRunning || this.isPaused) return;

        // 重连前重新获取最新动态连接凭证
        if (this.options.onRefreshInfo) {
          try {
            const freshInfo = await this.options.onRefreshInfo(String(this.options.desktop.desktopId));
            if (freshInfo && freshInfo.clinkLvsOutHost) {
              this.options.desktopInfo = freshInfo;
            }
          } catch (err: any) {
            this.log('warn', `刷新云电脑连接凭证失败: ${err.message}`);
          }
        }

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

      // 收到 Type 103 用户状态探测 -> 仅响应 Type 118 用户身份（后台静默保活）
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

          // 监听官方客户端状态通知 (Type 119/120/137 会话挤占/离线)
          if (info.type === 119 || info.type === 120 || info.type === 137) {
            this.log('warn', `收到服务端会话通知 (Type ${info.type})，检测到外部官方客户端接入，系统主动避让 5 分钟`);
            triggerReconnect(4001, `Type ${info.type} preempt`);
            return;
          }
        }
      } catch {}
    });

    ws.on('close', (code, reason) => triggerReconnect(code, reason));
    ws.on('error', (err) => this.log('error', `网络异常: ${err.message}`));
  }
}
