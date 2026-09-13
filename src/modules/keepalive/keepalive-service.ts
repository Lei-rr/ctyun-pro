import type { CtYunClient, Desktop, DesktopInfo } from '../../core/client.js';
import { KeepAliveWorker } from './worker.js';
import type { Logger } from '../../core/logger.js';
import { DesktopSessionArbiter } from '../arbiter/desktop-session-arbiter.js';
export interface ManagedDesktopState {
  desktopId: string;
  desktopName: string;
  desktopCode: string;
  useStatusText: string;
  imageName?: string;
  flavorName?: string;
  objType?: number;
  objId?: string;
  poolId?: string;
  isPool?: boolean;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';
  lastHeartbeat?: string;
  yieldStatus?: {
    yielding: boolean;
    remainingSeconds: number;
    reason?: string;
  };
}

/**
 * 现代化静默保活服务模块 (Keepalive Service)
 *
 * 规范与约束：
 * 1. 严格受控于 DesktopSessionArbiter (桌面长连接仲裁器)；
 * 2. 严禁私自违规建立重复 WebSocket，申请到租约后方可接入保活；
 * 3. 严格 30 秒活跃心跳节奏，心跳日志纯文本格式，支持防刷屏聚合；
 * 4. 遇到挂机任务或前台直连接入，秒级避让，主动挂起或释放。
 */
export class KeepaliveService {
  private workers: Map<string, KeepAliveWorker[]> = new Map();
  private logger: Logger;
  private onStateChange?: () => void;
  private arbiter: DesktopSessionArbiter;
  // 同账号防并发 Worker 同步锁
  private syncWorkersPromises: Map<string, Promise<void>> = new Map();

  constructor(logger: Logger, onStateChange?: () => void) {
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.arbiter = DesktopSessionArbiter.getInstance();
    this.arbiter.setLogger(logger);
  }

  /**
   * 停止指定账号下的所有保活 Worker
   */
  public stopWorkers(accountName: string): void {
    const list = this.workers.get(accountName);
    if (list) {
      for (const w of list) {
        try {
          const dId = (w as any).options?.desktop?.desktopId;
          if (dId) {
            this.arbiter.releaseLease(String(dId), 'keepalive', accountName).catch(() => {});
          }
          w.stop();
        } catch {}
      }
      this.workers.delete(accountName);
    }
  }

  /**
   * 停止单台云电脑的保活 Worker
   */
  public stopWorkerForDesktop(accountName: string, desktopCodeOrId: string): void {
    const list = this.workers.get(accountName);
    if (!list) return;

    const remaining: KeepAliveWorker[] = [];
    for (const w of list) {
      const d = (w as any).options?.desktop;
      if (d && (d.desktopCode === desktopCodeOrId || String(d.desktopId) === String(desktopCodeOrId))) {
        try {
          this.arbiter.releaseLease(String(d.desktopId), 'keepalive', accountName).catch(() => {});
          w.stop();
        } catch {}
      } else {
        remaining.push(w);
      }
    }
    if (remaining.length > 0) {
      this.workers.set(accountName, remaining);
    } else {
      this.workers.delete(accountName);
    }
  }

  /**
   * 软暂停指定账号下的保活 Worker
   */
  public pauseWorkers(accountName: string): boolean {
    const existing = this.workers.get(accountName);
    if (!existing || existing.length === 0) return false;
    for (const w of existing) {
      try {
        w.pause();
      } catch {}
    }
    return true;
  }

  /**
   * 恢复指定账号下的保活 Worker
   */
  public resumeWorkers(accountName: string): boolean {
    const existing = this.workers.get(accountName);
    if (!existing || existing.length === 0) return false;
    for (const w of existing) {
      try {
        w.resume();
      } catch {}
    }
    return true;
  }

  /**
   * 停止全部保活工作者
   */
  public stopAll(): void {
    for (const [acc, workers] of this.workers.entries()) {
      for (const w of workers) {
        try {
          const dId = (w as any).options?.desktop?.desktopId;
          if (dId) {
            this.arbiter.releaseLease(String(dId), 'keepalive', acc).catch(() => {});
          }
          w.stop();
        } catch {}
      }
    }
    this.workers.clear();
  }

  /**
   * 核心保活调度：按最新云电脑列表智能创建、销毁与维持受控保活连接
   */
  public async syncWorkersForAccount(
    accountName: string,
    client: CtYunClient,
    desktops: Desktop[],
    desktopStates: ManagedDesktopState[],
    isManualShutdown?: (desktopId: string) => boolean,
  ): Promise<void> {
    if (!client.loginInfo) return;

    const existingPromise = this.syncWorkersPromises.get(accountName);
    if (existingPromise) {
      return existingPromise;
    }

    const task = (async () => {
      try {
        await this._doSyncWorkersForAccount(accountName, client, desktops, desktopStates, isManualShutdown);
      } finally {
        this.syncWorkersPromises.delete(accountName);
      }
    })();

    this.syncWorkersPromises.set(accountName, task);
    return task;
  }

  private async _doSyncWorkersForAccount(
    accountName: string,
    client: CtYunClient,
    desktops: Desktop[],
    desktopStates: ManagedDesktopState[],
    isManualShutdown?: (desktopId: string) => boolean,
  ): Promise<void> {
    if (!client.loginInfo) return;

    // 检查是否所有 Worker 都在健康运行
    const existingWorkers = this.workers.get(accountName) || [];
    if (existingWorkers.length > 0 && existingWorkers.every((w) => (w as any).isRunning)) {
      return;
    }

    this.stopWorkers(accountName);
    const newWorkers: KeepAliveWorker[] = [];

    for (let i = 0; i < desktops.length; i++) {
      const d = desktops[i];
      const state = desktopStates[i];

      const dCode = d.desktopCode || d.desktopId;
      const dName = d.desktopName || (d as any).computerName || (d as any).name || dCode;
      const dPrefix = dName ? `${accountName} - ${dName}` : accountName;
      const dIdStr = String(d.desktopId);

      // 外部客户端避让或高优先级独占避让：若桌面正处于智能挂机、前台直连或外部避让中，保活通道暂缓建立
      if (this.arbiter.isBusy(dIdStr) || (dCode && this.arbiter.isBusy(String(dCode)))) {
        const yieldStatus = this.arbiter.getYieldStatus(dIdStr);
        if (yieldStatus.yielding) {
          this.logger.addLog(
            'info',
            `[${dPrefix}] 桌面处于外部官方客户端主动避让期 (剩余 ${yieldStatus.remainingSeconds}秒)，保活通道暂缓建立`,
          );
          if (state && state.status !== 'reconnecting') {
            state.status = 'reconnecting';
          }
        } else {
          this.logger.addLog('info', `[${dPrefix}] 桌面正在执行高优先级业务 (挂机/直连)，保活通道暂缓建立`);
        }
        continue;
      }

      // 手动关机锁定拦截
      if (isManualShutdown && isManualShutdown(dCode)) {
        if (state) {
          state.status = 'stopped';
          state.useStatusText = '已关机';
        }
        this.logger.addLog('info', `[${dPrefix}] 处于手动关机锁定状态，跳过自动唤醒与保活`);
        continue;
      }

      // 开机检测与开机指令
      const isRunning = d.useStatusText === '运行中' || d.useStatusText === '离线运行';
      if (!isRunning) {
        this.logger.addLog('warn', `[${dPrefix}] 当前状态: [${d.useStatusText}]，正在下发自动开机指令...`);
        try {
          await client.operateDesktop(d.desktopId, 'on');
        } catch (e: any) {
          this.logger.addLog('warn', `[${dPrefix}] 自动开机提示: ${e.message}`);
        }

        let ready = false;
        const maxWaitLoops = 15; // 20s 轮询一次，最长 5 分钟 (15 次)
        for (let waitLoop = 1; waitLoop <= maxWaitLoops; waitLoop++) {
          await new Promise((r) => setTimeout(r, 20000));
          try {
            const latestList = await client.getDesktopList();
            const cur = latestList.find((item) => String(item.desktopId) === dIdStr || String(item.desktopCode) === String(d.desktopCode));
            if (cur && (cur.useStatusText === '运行中' || cur.useStatusText === '离线运行')) {
              d.useStatusText = cur.useStatusText;
              ready = true;
              this.logger.addLog('success', `[${dPrefix}] 云电脑已成功开机`);
              break;
            }
          } catch {}
        }
        if (!ready) {
          this.logger.addLog('warn', `[${dPrefix}] 云电脑开机仍在进行中，稍后将自动接入保活`);
          continue;
        }
      }

      // 获取信道连接参数
      let info: DesktopInfo | null = null;
      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          info = await client.connectDesktop(d);
          if (info && info.clinkLvsOutHost) break;
        } catch (e: any) {
          if (attempt === maxRetries) {
            this.logger.addLog('warn', `[${dPrefix}] 暂时未能获取到云电脑连接信道，将在下个周期自动重试`);
            break;
          }
          await new Promise((r) => setTimeout(r, 4000));
        }
      }

      if (!info) {
        continue;
      }

      try {
        d.desktopInfo = info;

        // 向桌面仲裁器申请 keepalive 租约
        let workerInstance: KeepAliveWorker | null = null;
        const acquired = await this.arbiter.acquireLease(
          dIdStr,
          'keepalive',
          accountName,
          async () => {
            // 当被高优先级（挂机或前台直连）抢占时的优雅释放回调
            if (workerInstance) {
              workerInstance.pause();
            }
          },
        );

        if (!acquired) {
          this.logger.addLog('info', `[${dPrefix}] 桌面正在执行高优先级业务，保活通道暂缓建立`);
          continue;
        }

        workerInstance = new KeepAliveWorker({
          accountName,
          desktop: d,
          desktopInfo: info,
          loginInfo: client.loginInfo,
          deviceCode: client.getDeviceCode(),
          onLog: (level, msg) => this.logger.addLog(level, msg),
          onStatusChange: (status) => {
            if (state) {
              state.status = status;
              if (status === 'connected') {
                state.useStatusText = '运行中';
              }
            }
            this.onStateChange?.();
          },
          onHeartbeat: () => {
            if (state) {
              state.lastHeartbeat = new Date().toLocaleTimeString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              });
              state.useStatusText = '运行中';
            }
            this.onStateChange?.();
          },
          onRefreshInfo: async () => {
            try {
              // 关键自愈：强制要求官方签发全新凭据 (forceFresh=true)
              const newInfo = await client.connectDesktop(d, 0, true);
              if (newInfo && newInfo.clinkLvsOutHost) {
                d.desktopInfo = newInfo;
                return newInfo;
              }
            } catch (err: any) {
              // 换票异常由 worker 自适应退避
            }
            return null;
          },
        });

        workerInstance.start();
        newWorkers.push(workerInstance);
      } catch (err: any) {
        this.logger.addLog('error', `[${dPrefix}] 保活连接建立失败: ${err.message}`);
      }
    }

    this.workers.set(accountName, newWorkers);
  }
}
