import WebSocket from 'ws';
import { Protocol, ClinkMsgType } from '../../core/protocol.js';
import type { Desktop, DesktopInfo } from '../../core/client.js';
import { DesktopSessionArbiter } from '../arbiter/desktop-session-arbiter.js';

export interface KeepAliveWorkerOptions {
  accountName: string;
  desktop: Desktop;
  desktopInfo: DesktopInfo;
  loginInfo: any;
  deviceCode: string;
  onStatusChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'stopped') => void;
  onHeartbeat?: () => void;
  onRefreshInfo?: () => Promise<DesktopInfo | null>;
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
  private isHandshakeComplete = false;
  private consecutiveFailures = 0;
  private needsFreshTicket = false;
  private lastGatewayError = '';
  private handshakeTimeout: NodeJS.Timeout | null = null;
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
    this.isHandshakeComplete = false;
    this.consecutiveFailures = 0;
    this.needsFreshTicket = false;
    this.lastGatewayError = '';
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
    this.isHandshakeComplete = false;
    this.consecutiveFailures = 0;
    this.needsFreshTicket = false;
    this.lastGatewayError = '';
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
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
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

  private isCertValid(cert?: string): boolean {
    if (!cert || typeof cert !== 'string' || cert.trim().length === 0) return false;
    try {
      const buf = Buffer.from(cert, 'base64');
      return buf.length > 20;
    } catch {
      return false;
    }
  }

  private markHandshakeSuccess(ws: WebSocket): void {
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    if (!this.isHandshakeComplete) {
      this.isHandshakeComplete = true;
      this.consecutiveFailures = 0;
      this.needsFreshTicket = false;
      this.lastGatewayError = '';
      this.options.onStatusChange?.('connected');
      this.log('success', '云电脑保活会话建立成功');

      // 启动官方标准的 30s 活跃心跳定时器
      if (!this.heartbeatTimer) {
        this.heartbeatTimer = setInterval(() => this.sendClientHeartbeat(), 30000);
      }
    }
  }

  private async connect(): Promise<void> {
    if (!this.isRunning || this.isPaused) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
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

    // 凭据有效性前置防御检查
    if (!this.isCertValid(this.options.desktopInfo?.clientCert)) {
      this.log('warn', '检测到长连接凭据证书不完整，准备向官方申请全新凭据...');
      this.needsFreshTicket = true;
    }

    // 如果标记需要刷新凭据，在建立连接前主动换取全新 Ticket
    if (this.needsFreshTicket && this.options.onRefreshInfo) {
      try {
        this.log('info', '正在向官方调度中心申请全新 Ticket 与连接凭据...');
        const newInfo = await this.options.onRefreshInfo();
        if (newInfo && newInfo.clinkLvsOutHost) {
          this.options.desktopInfo = newInfo;
          this.needsFreshTicket = false;
          this.log('info', '已成功换取全新长连接凭据');
        } else {
          throw new Error('调度中心未返回有效网关凭据');
        }
      } catch (e: any) {
        this.log('warn', `换取长连接凭据提示: ${e.message}`);
        this.isReconnecting = false;
        const retryDelay = Math.min(5000 * Math.max(1, this.consecutiveFailures), 30000);
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, retryDelay);
        return;
      }
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
      }

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.handshakeTimeout) {
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = null;
      }
      this.cleanupSocket();

      let retryDelay = isConflict ? 300000 : 5000;

      if (!isConflict) {
        const isZombieWakeup = this.lastGatewayError.includes('zombie');
        const isConnectionRefused =
          this.lastGatewayError.includes('connection refused') || this.lastGatewayError.includes('failed to connect');

        if (this.isHandshakeComplete) {
          // 运行中正常网络断开：重置握手完成标记
          this.isHandshakeComplete = false;
          this.consecutiveFailures = 0;
          this.needsFreshTicket = true;

          if (isZombieWakeup) {
            // 收到 zombie：官方会话挂起/回收，立即于 1 秒内发起连接敲门以唤醒官方服务冷启动
            retryDelay = 1000;
            this.log('info', `网关轻量线程挂起 (${code})，1秒内发起唤醒连接以触发官方服务冷启动...`);
          } else {
            this.log('info', `网络连接断开 (${code}, ${reasonStr || '远程连接关闭'})，5秒后自动重连...`);
          }
        } else {
          // 未完成握手即断开（如网关 1005 关闭或拒接）：累计握手失败计数
          this.consecutiveFailures++;
          // 握手失败/被拒接，下次必须强制申请全新 Ticket！天翼云 Ticket 为单次消费凭据，不可复用！
          this.needsFreshTicket = true;

          if (isConnectionRefused) {
            // connection refused 说明云电脑服务正在冷启动中 (端口 7003 尚未就绪)
            // 采用平滑阶梯退避 (3s -> 5s -> 10s)，每次重新申请全新 Ticket 接入
            if (this.consecutiveFailures <= 2) {
              retryDelay = 3000;
            } else if (this.consecutiveFailures <= 4) {
              retryDelay = 5000;
            } else {
              retryDelay = 10000;
            }
            this.log('info', `云电脑服务正在拉起就绪中，${retryDelay / 1000}秒后申请全新凭据接入长连接 (连续重试 ${this.consecutiveFailures} 次)...`);
          } else {
            // 阶梯指数退避：5s -> 10s -> 20s -> 30s，最高 60s
            if (this.consecutiveFailures === 1) {
              retryDelay = 5000;
            } else if (this.consecutiveFailures === 2) {
              retryDelay = 10000;
            } else if (this.consecutiveFailures === 3) {
              retryDelay = 20000;
            } else if (this.consecutiveFailures === 4) {
              retryDelay = 30000;
            } else {
              retryDelay = 60000;
            }

            const retryDelaySec = Math.round(retryDelay / 1000);
            this.log(
              'warn',
              `长连接握手未完成即断开 (${code}, ${reasonStr || '远程连接关闭'})，${retryDelaySec}秒后换取新凭据重试 (连续重试 ${this.consecutiveFailures} 次)...`,
            );
          }
        }
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.isReconnecting = false;
        if (!this.isRunning || this.isPaused) return;
        this.connect();
      }, retryDelay);
    };

    ws.on('open', async () => {
      this.log('success', 'WebSocket 连接就绪，发送握手配置...');

      // 1. 发送连接握手 JSON
      const currentInfo = this.options.desktopInfo;
      const currentHostParts = currentInfo.clinkLvsOutHost.split(':');
      const connectMessage = {
        type: 1,
        ssl: 1,
        host: currentHostParts[0],
        port: currentHostParts.length > 1 ? currentHostParts[1] : '443',
        ca: currentInfo.caCert,
        cert: currentInfo.clientCert,
        key: currentInfo.clientKey,
        servername: `${currentInfo.host}:${currentInfo.port}`,
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
          // 注意：此处等待服务端实际协议回包确认，绝不假定握手成功
        } catch (err: any) {
          this.log('error', `握手流程异常: ${err.message}`);
        }
      }, 500);

      // 3. 设置 15 秒握手超时防护
      this.handshakeTimeout = setTimeout(() => {
        if (!this.isHandshakeComplete && ws.readyState === WebSocket.OPEN) {
          this.log('warn', '长连接握手未在规定时间内收到网关响应，主动断开重试');
          ws.close(1006, 'Handshake Timeout');
        }
      }, 15000);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (!this.isRunning || this.isPaused) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      // A. 识别网关明文拒绝错误 (如 ": failed to decode_base64,cert")
      if (buffer.length > 0 && buffer.length < 256) {
        const text = buffer.toString('utf8');
        if (
          text.startsWith(':') ||
          text.includes('failed') ||
          text.includes('decode_base64') ||
          text.includes('cert') ||
          text.toLowerCase().includes('error')
        ) {
          this.lastGatewayError = text.trim();
          this.log('warn', `网关拒绝连接: ${text.trim()}`);
          this.needsFreshTicket = true;
          return;
        }
      }

      // B. 收到 REDQ 保活校验帧 -> 动态响应并确认会话成功
      if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'REDQ') {
        this.markHandshakeSuccess(ws);
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

      // C. 收到单字节握手确认帧 (0x01)
      if (buffer.length === 1 && buffer[0] === 1) {
        this.markHandshakeSuccess(ws);
        return;
      }

      // D. 收到 Clink 协议消息 -> 按照官方规范分发响应
      try {
        const infos = Protocol.parseSendInfo(buffer);
        if (infos.length > 0) {
          this.markHandshakeSuccess(ws);
        }

        for (const info of infos) {
          // 官方规范: 收到服务端 Type 3 ACK 窗口协商 -> 回复 Type 1 ACK_SYNC
          if (info.type === ClinkMsgType.MSG_SET_ACK && info.data && info.data.length >= 4) {
            const generation = info.data.readUInt32LE(0);
            const ackSync = Protocol.buildAckSync(generation);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(ackSync);
            }
          }

          // 官方规范: 收到服务端 Type 4 Ping 探测 -> 立即回复 Type 3 Pong
          if (info.type === ClinkMsgType.MSG_PING) {
            const pong = Protocol.buildPong();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(pong);
            }
          }

          // 官方规范: 收到服务端心跳回执确认 (Type 9 CLINK_MSG_HEARTBEAT_RES / Type 8)
          if (info.type === ClinkMsgType.MSG_HEARTBEAT_RES || info.type === ClinkMsgType.HEARTBEAT_ACK) {
            this.consecutiveFailures = 0;
            this.isHandshakeComplete = true;
          }

          // 收到 Type 103 主通道握手挑战 -> 仅响应 Type 118 用户身份（后台静默保活）
          if (info.type === ClinkMsgType.MSG_MAIN_INIT) {
            const byUserName = Protocol.buildClientUserName(
              this.options.loginInfo.userName,
              this.options.loginInfo.userId,
            );
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(byUserName);
            }
          }

          // 监听官方客户端状态通知 (Type 119 离线 / 120 挤占锁定 / 137 主通道结束)
          if (
            info.type === ClinkMsgType.MSG_MAIN_CLIENT_OFFLINE ||
            info.type === ClinkMsgType.MSG_MAIN_DESKTOP_LOCKED ||
            info.type === ClinkMsgType.MSG_END_MAIN
          ) {
            this.log('warn', `收到服务端会话通知 (Type ${info.type})，检测到外部官方客户端接入，系统主动避让 5 分钟`);
            triggerReconnect(4001, `Type ${info.type} preempt`);
            return;
          }
        }
      } catch {}
    });

    ws.on('close', (code, reason) => triggerReconnect(code, reason));
    ws.on('error', (err) => {
      this.lastGatewayError = err.message || '';
      this.log('error', `网络异常: ${err.message}`);
    });
  }
}
