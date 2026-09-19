import WebSocket from 'ws';
import { errorText } from '../../infra/http.js';
import { Protocol, ClinkMsgType } from '../../clink/protocol.js';
import { DEFAULT_CLINK_WS_HOST, type Desktop, type DesktopInfo, type LoginInfo } from '../../ctyun/client.js';

/**
 * 活跃心跳间隔 (响应驱动)
 * 官方 web 端 MAIN 通道为 5000ms；后台静默保活采用 30s 更省资源且已生产验证，
 * 可通过环境变量 CTYUN_HEARTBEAT_INTERVAL_MS 调整 (建议范围 5000~60000)
 */
const HEARTBEAT_INTERVAL_MS = Math.max(
  5000,
  Math.min(60000, Number(process.env.CTYUN_HEARTBEAT_INTERVAL_MS) || 30000),
);
/** 心跳回执兜底重排间隔：收到回执前按 1.5 倍间隔续发，防断流 */
const HEARTBEAT_RES_FALLBACK_MS = Math.min(HEARTBEAT_INTERVAL_MS * 1.5, 90000);

export interface KeepAliveWorkerOptions {
  accountName: string;
  desktop: Desktop;
  desktopInfo: DesktopInfo;
  loginInfo: LoginInfo;
  deviceCode: string;
  onStatusChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'stopped') => void;
  onPreempted?: (code: number, reason: string) => void;
  onHeartbeat?: () => void;
  onRefreshInfo?: () => Promise<DesktopInfo | null>;
  onLog?: (
    level: 'info' | 'warn' | 'error' | 'success',
    msg: string,
    meta?: { foldKey?: string },
  ) => void;
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
  public readonly options: KeepAliveWorkerOptions;
  private currentWs: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  public isRunning = false;
  private isReconnecting = false;
  private isConnecting = false;
  /** 在途连接期间收到 resume/重连请求时置位, 连接流程结束后自动重试 */
  private pendingReconnect = false;
  public isPaused = false;
  private isHandshakeComplete = false;
  private consecutiveFailures = 0;
  public needsFreshTicket = false;
  private lastGatewayError = '';
  private handshakeTimeout: NodeJS.Timeout | null = null;
  // 官方 Clink ACK 滑动窗口 (对齐 msgs_until_ack / ack_window)
  private ackWindow = 0;
  private msgsUntilAck = 0;
  // 104 通道挂接就绪是否已发送 (官方在收到 136 回执后发送)
  private attachChannelsSent = false;
  // 最近一次收到网关切数据时间戳 (用于心跳存活检测，识别 TCP 黑洞假死)
  private lastInboundAt = 0;
  // 已连续发送心跳未收到任何回包的心跳次数
  private unackedHeartbeats = 0;

  constructor(options: KeepAliveWorkerOptions) {
    this.options = options;
  }

  private log(level: 'info' | 'warn' | 'error' | 'success', msg: string, meta?: { foldKey?: string }) {
    this.options.onLog?.(level, msg, meta);
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
    this.isConnecting = false;
    this.pendingReconnect = false;
    this.isHandshakeComplete = false;
    this.consecutiveFailures = 0;
    this.needsFreshTicket = false;
    this.lastGatewayError = '';
    this.ackWindow = 0;
    this.msgsUntilAck = 0;
    this.attachChannelsSent = false;
    this.lastInboundAt = 0;
    this.unackedHeartbeats = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
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
    this.pendingReconnect = false;
    this.isHandshakeComplete = false;
    this.consecutiveFailures = 0;
    this.needsFreshTicket = false;
    this.lastGatewayError = '';
    this.ackWindow = 0;
    this.msgsUntilAck = 0;
    this.attachChannelsSent = false;
    this.lastInboundAt = 0;
    this.unackedHeartbeats = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.cleanupSocket();
    this.log('info', '保活通道已暂停，等待任务结束后恢复');
    this.options.onStatusChange?.('paused');
  }

  /**
   * 恢复保活连接
   */
  public resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
    // 若此刻仍有在途连接流程, 置位待恢复意图由其结束后接续 (否则本次 resume 会丢失)
    if (this.isConnecting) {
      this.pendingReconnect = true;
      this.log('info', '任务完成，等待当前连接流程结束后恢复保活');
      return;
    }
    this.log('info', '任务完成，正在恢复保活连接');
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
        // CONNECTING 状态下 close() 会异步触发 error 事件, 无监听将导致进程崩溃, 必须兜底吞掉
        this.currentWs.on('error', () => {});
        if (this.currentWs.readyState === WebSocket.OPEN || this.currentWs.readyState === WebSocket.CONNECTING) {
          this.currentWs.close(1000, 'Worker cleanup');
        }
      } catch {}
      this.currentWs = null;
    }
  }

  /**
   * 调度下一次重连 (幂等: 已有定时器在途时被忽略，避免与 close 事件重复触发建连)
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.isReconnecting = false;
      if (!this.isRunning || this.isPaused) return;
      this.connect();
    }, delayMs);
  }

  /**
   * 调度下一次活跃心跳
   * 对齐官方响应驱动模型: 收到心跳回执后间隔 heartInterval(5s) 再发下一次
   */
  private scheduleNextHeartbeat(delayMs: number): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.isRunning || this.isPaused) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      this.sendClientHeartbeat();
    }, Math.max(1000, delayMs));
  }

  /** 发送官方活跃心跳 (Type 7)，并执行链路存活检测 */
  private sendClientHeartbeat(): void {
    if (!this.isRunning || this.isPaused || !this.currentWs || this.currentWs.readyState !== WebSocket.OPEN) return;

    // 存活检测：若连续多个心跳周期内未收到网关任何数据，判定链路黑洞假死，强制断开重连
    // (避免 TCP 连接存在但网关已死导致的“假在线”永久挂死)
    if (this.lastInboundAt > 0) {
      const silentMs = Date.now() - this.lastInboundAt;
      const silentThreshold = Math.max(HEARTBEAT_INTERVAL_MS * 3, 60000);
      if (silentMs > silentThreshold) {
        this.unackedHeartbeats += 1;
        if (this.unackedHeartbeats >= 2) {
          this.log('warn', `网关静默 ${Math.round(silentMs / 1000)}s 且心跳无回包，判定链路假死，主动断开重连`);
          this.needsFreshTicket = true;
          try {
            this.currentWs.close(4003, 'Heartbeat Timeout');
          } catch {}
          return;
        }
      }
    }

    try {
      const hbBuf = Protocol.buildHeartbeat();
      this.currentWs.send(hbBuf);
      this.log('info', '发送活跃心跳，维持云端会话在线', { foldKey: 'keepalive:heartbeat' });
      this.options.onHeartbeat?.();
      // 兜底：若 10s 内未收到 HEARTBEAT_RES (handleHeartBeatRes 会重排)，则仍按节奏续发，避免断流
      this.scheduleNextHeartbeat(HEARTBEAT_RES_FALLBACK_MS);
    } catch (err) {
      const msg = errorText(err);
      this.log('warn', `发送心跳失败: ${msg}`);
      this.scheduleNextHeartbeat(HEARTBEAT_RES_FALLBACK_MS);
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

  private markHandshakeSuccess(): void {
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
    if (!this.isHandshakeComplete) {
      this.isHandshakeComplete = true;
      this.consecutiveFailures = 0;
      this.needsFreshTicket = false;
      this.lastGatewayError = '';
      this.lastInboundAt = Date.now();
      this.unackedHeartbeats = 0;
      this.options.onStatusChange?.('connected');
      this.log('success', '保活会话已建立，进入稳定心跳保活状态');

      // 启动响应驱动活跃心跳 (对齐官方 MAIN 通道模型，间隔可配置)
      this.scheduleNextHeartbeat(HEARTBEAT_INTERVAL_MS);
    }
  }

  /**
   * 构建 MAIN 通道连接地址
   * 主路径: 官方调度返回的 clinkLvsOutHost + /clinkProxy/<desktopId>/MAIN (生产验证可用)
   * 兜底:   若调度未返回 clinkLvsOutHost，则回退官方标准网关 wss://deskmsgz.ctyun.cn:9011/clinkProxy/<desktopId>
   */
  private buildMainChannelUrl(desktopInfo: DesktopInfo, desktopId: string): string {
    const rawGateway = String(desktopInfo.clinkLvsOutHost || '').trim();
    if (rawGateway) {
      const normalized = rawGateway.replace(/^https?:\/\//, '').replace(/\/$/, '');
      return `wss://${normalized}/clinkProxy/${desktopId}/MAIN`;
    }
    return `${DEFAULT_CLINK_WS_HOST.replace(/\/$/, '')}/${desktopId}`;
  }

  private async connect(): Promise<void> {
    // 并发守卫: 多入口 (start/resume/重试/重连定时器) 可能同时触发,
    // 无守卫会创建孤儿连接 (旧 WS 仍在发心跳), 导致重复会话与资源泄漏
    if (!this.isRunning || this.isPaused) return;
    // 在途连接直接丢弃 (重复 start/重连定时器), 避免孤儿连接
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      await this._connectInternal();
    } finally {
      this.isConnecting = false;
      // 仅 resume() 显式置位的待恢复意图才接续, 避免重复 start 触发多余连接
      if (this.pendingReconnect) {
        this.pendingReconnect = false;
        if (this.isRunning && !this.isPaused) {
          this.connect();
        }
      }
    }
  }

  private async _connectInternal(): Promise<void> {
    if (!this.isRunning || this.isPaused) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }

    this.cleanupSocket();

    // 凭据有效性前置防御检查
    if (!this.isCertValid(this.options.desktopInfo?.clientCert)) {
      this.log('warn', '连接凭据不完整，将重新申请');
      this.needsFreshTicket = true;
    }

    // 如果标记需要刷新凭据，在建立连接前主动换取全新 Ticket
    if (this.needsFreshTicket && this.options.onRefreshInfo) {
      try {
        const newInfo = await this.options.onRefreshInfo();
        if (newInfo && newInfo.clinkLvsOutHost) {
          this.options.desktopInfo = newInfo;
          this.needsFreshTicket = false;
        } else {
          throw new Error('调度中心未返回有效网关凭据');
        }
      } catch (e) {
        const msg = errorText(e);
        // 申请凭据失败按 5s -> 10s -> 20s -> 30s 退避，避免网络瞬断时高频轰炸官方调度中心
        this.consecutiveFailures++;
        const retryDelay = this.consecutiveFailures <= 1 ? 5000
          : this.consecutiveFailures === 2 ? 10000
          : this.consecutiveFailures === 3 ? 20000
          : 30000;
        this.log('warn', `申请连接凭据失败 (${msg})，${retryDelay / 1000}s 后重试 (第 ${this.consecutiveFailures} 次)`);
        this.isReconnecting = false;
        this.scheduleReconnect(retryDelay);
        return;
      }
    }

    // 异步换取凭据期间可能已被 pause/stop, 必须复检状态避免创建孤儿连接
    if (!this.isRunning || this.isPaused) return;

    this.isReconnecting = false;
    this.options.onStatusChange?.('connecting');

    const { desktopInfo, desktop } = this.options;
    // 官方 web 端使用 clink 网关地址: wss://<gateway>/clinkProxy/<desktopId>
    // 优先使用官方标准网关，若 desktopInfo 提供了自定义 http(s) 接入域名则回退兼容
    const mainUrl = this.buildMainChannelUrl(desktopInfo, String(desktop.desktopId));

    this.log('info', `正在建立长连接 ${mainUrl}`);

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
        if (this.heartbeatTimer) {
          clearTimeout(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.handshakeTimeout) {
          clearTimeout(this.handshakeTimeout);
          this.handshakeTimeout = null;
        }
        this.cleanupSocket();
        this.isReconnecting = false;
        this.isPaused = true;
        this.needsFreshTicket = true;
        this.log('warn', `检测到官方客户端接入 (${code}${reasonStr ? ' ' + reasonStr : ''})，后台保活主动让位`);
        this.options.onStatusChange?.('paused');
        this.options.onPreempted?.(code, reasonStr);
        return;
      }

      if (this.heartbeatTimer) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.handshakeTimeout) {
        clearTimeout(this.handshakeTimeout);
        this.handshakeTimeout = null;
      }
      this.cleanupSocket();

      let retryDelay = 5000;

      const isConnectionRefused =
        this.lastGatewayError.includes('connection refused') || this.lastGatewayError.includes('failed to connect');

      if (this.isHandshakeComplete) {
        // 运行中正常网络断开：重置握手完成标记
        this.isHandshakeComplete = false;
        this.consecutiveFailures = 0;
        this.needsFreshTicket = true;
        this.log('info', `连接断开 (${code}${reasonStr ? ' ' + reasonStr : ''})，5s 后重连`);
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
          this.log('info', `云电脑服务启动中，${retryDelay / 1000}s 后重新申请连接凭据 (第 ${this.consecutiveFailures} 次重试)`);
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
            `握手未完成即断开 (${code}${reasonStr ? ' ' + reasonStr : ''})，${retryDelaySec}s 后重新申请连接凭据 (第 ${this.consecutiveFailures} 次重试)`,
          );
        }
      }

      this.scheduleReconnect(retryDelay);
    };

    ws.on('open', async () => {

      // 1. 发送连接握手 JSON
      // 对齐官方: 若调度返回 internalIp/internalPort (真实虚拟机地址) 则作为 servername，否则沿用 host:port
      const currentInfo = this.options.desktopInfo;
      const hostParts = String(currentInfo.clinkLvsOutHost || '').split(':');
      const servername =
        currentInfo.internalIp && currentInfo.internalPort
          ? `${currentInfo.internalIp}:${currentInfo.internalPort}`
          : `${currentInfo.host}:${currentInfo.port}`;
      const connectMessage = {
        type: 1,
        ssl: 1,
        host: hostParts[0] || currentInfo.host,
        port: hostParts.length > 1 ? hostParts[1] : currentInfo.port || '443',
        ca: currentInfo.caCert,
        cert: currentInfo.clientCert,
        key: currentInfo.clientKey,
        servername,
        oqs: 0,
      };

      try {
        ws.send(JSON.stringify(connectMessage));
      } catch (err) {
        const msg = errorText(err);
        this.log('error', `发送连接配置失败: ${msg}`);
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
        } catch (err) {
          const msg = errorText(err);
          this.log('error', `握手流程异常: ${msg}`);
        }
      }, 500);

      // 3. 设置 15 秒握手超时防护
      this.handshakeTimeout = setTimeout(() => {
        if (!this.isHandshakeComplete && ws.readyState === WebSocket.OPEN) {
          this.log('warn', '握手超时未收到网关响应，断开重试');
          ws.close(1006, 'Handshake Timeout');
        }
      }, 15000);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (!this.isRunning || this.isPaused) return;
      this.lastInboundAt = Date.now();
      this.unackedHeartbeats = 0;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

      // A. 识别网关明文拒绝错误 (如 ": failed to decode_base64,cert")
      // 仅在握手完成前判定，避免误杀正常二进制协议帧
      if (!this.isHandshakeComplete && buffer.length > 0 && buffer.length < 256) {
        const text = buffer.toString('utf8');
        const isGatewayPlainError =
          text.startsWith(':') ||
          text.includes('decode_base64') ||
          text.includes('failed to') ||
          /\bcert(ificate)?\b/i.test(text) ||
          /\berror\b/i.test(text);
        if (isGatewayPlainError) {
          this.lastGatewayError = text.trim();
          this.log('warn', `网关拒绝连接: ${text.trim()}，将重新申请连接凭据`);
          this.needsFreshTicket = true;
          try {
            ws.close(4002, 'Gateway rejected');
          } catch {}
          return;
        }
      }

      // B. 收到 REDQ 保活校验帧 -> 动态响应并确认会话成功
      if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'REDQ') {
        this.markHandshakeSuccess();
        try {
          const response = Protocol.buildRedqResponse(buffer);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(response);
          }
        } catch (err) {
          const msg = errorText(err);
          this.log('error', `保活加密校验处理异常: ${msg}`);
        }
        return;
      }

      // C. 收到单字节握手确认帧 (0x01)
      if (buffer.length === 1 && buffer[0] === 1) {
        this.markHandshakeSuccess();
        return;
      }

      // D. 收到 Clink 协议消息 -> 按照官方规范分发响应
      try {
        const infos = Protocol.parseSendInfo(buffer);
        if (infos.length > 0) {
          this.markHandshakeSuccess();
        }

        for (const info of infos) {
          // 官方规范: 收到服务端 Type 3 ACK 窗口协商 -> 回复 Type 1 ACK_SYNC，并建立滑动窗口
          if (info.type === ClinkMsgType.MSG_SET_ACK && info.data && info.data.length >= 8) {
            const generation = info.data.readUInt32LE(0);
            this.ackWindow = info.data.readUInt32LE(4);
            this.msgsUntilAck = this.ackWindow;
            const ackSync = Protocol.buildAckSync(generation);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(ackSync);
            }
          }

          // 官方规范: 收到服务端 Type 4 Ping 探测 -> 立即回复 Type 3 Pong (回显前 12 字节)
          if (info.type === ClinkMsgType.MSG_PING) {
            const pong = Protocol.buildPong(info.data && info.data.length > 0 ? Buffer.from(info.data) : undefined);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(pong);
            }
          }

          // 官方规范: 收到服务端心跳回执确认 (Type 9 CLINK_MSG_HEARTBEAT_RES)
          if (info.type === ClinkMsgType.MSG_HEARTBEAT_RES) {
            this.consecutiveFailures = 0;
            this.isHandshakeComplete = true;
            // 响应驱动: 收到回执后立即按设定节奏重排下一次心跳
            this.scheduleNextHeartbeat(HEARTBEAT_INTERVAL_MS);
          }

          // 官方规范: 滑动窗口 ACK —— 每接收 ack_window 条消息回发一次 MSGC_ACK (Type 2)
          if (this.ackWindow > 0) {
            this.msgsUntilAck -= 1;
            if (this.msgsUntilAck <= 0) {
              this.msgsUntilAck = this.ackWindow;
              try {
                if (ws.readyState === WebSocket.OPEN) ws.send(Protocol.buildAck());
              } catch {}
            }
          }

          // 收到 Type 103 主通道握手挑战 -> 回复 118 身份 + 112 凭据认领 + 104 信道挂接 (对齐官方 Web 客户端)
          if (info.type === ClinkMsgType.MSG_MAIN_INIT) {
            const byUserName = Protocol.buildClientUserName(
              this.options.loginInfo.userName,
              this.options.loginInfo.userId,
            );
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(byUserName);
            }

            // 发送 Type 112 会话认领包 (CLINK_MSGC_MAIN_CLIENT_LOGIN_INFO)
            // 声明为桌面合法拥有者并激活在席 Session，彻底根除网关因空占位触发的 light thread 僵尸回收
            try {
              const msg112 = Protocol.buildMainClientLoginInfo(
                String(desktop.desktopId),
                desktopInfo.token || '',
                '60',
                this.options.deviceCode || '',
                this.options.loginInfo.userName || '',
              );
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg112);
              }
            } catch {}

            // 主动查询 Clink 版本 (Type 116)
            setTimeout(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                  ws.send(Protocol.buildGetClinkVersion());
                } catch {}
              }
            }, 500);

            // 防御性兜底：若 3 秒内未收到官方 136 登录认领回执，仍补发一次 104 通道挂接
            setTimeout(() => {
              if (this.attachChannelsSent) return;
              if (!this.isRunning || this.isPaused || ws.readyState !== WebSocket.OPEN) return;
              try {
                ws.send(Protocol.buildAttachChannels());
                this.attachChannelsSent = true;
              } catch {}
            }, 3000);
          }

          // 官方规范: 收到 Type 136 登录认领回执后，回复 Type 104 通道挂接就绪
          if (info.type === ClinkMsgType.MSG_MAIN_CLIENT_LOGIN_INFO_RES) {
            try {
              if (!this.attachChannelsSent) {
                const msg104 = Protocol.buildAttachChannels();
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(msg104);
                  this.attachChannelsSent = true;
                }
              }
            } catch {}
          }

          // 监听官方客户端状态通知 (Type 119 离线 / 120 挤占锁定 / 137 主通道结束)
          if (
            info.type === ClinkMsgType.MSG_MAIN_CLIENT_OFFLINE ||
            info.type === ClinkMsgType.MSG_MAIN_DESKTOP_LOCKED ||
            info.type === ClinkMsgType.MSG_END_MAIN
          ) {
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
