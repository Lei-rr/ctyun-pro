import type { CtYunClient, Desktop, DesktopInfo } from '../core/client.js';
import { KeepAliveWorker } from './worker.js';
import type { Logger } from '../core/logger.js';

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
}

/**
 * 多账号、多云电脑保活守护协调管理器
 * 负责 7x24 小时维持所有云电脑的持久长连接，与上层任务逻辑彻底解耦
 */
export class KeepAliveManager {
  private workers: Map<string, KeepAliveWorker[]> = new Map();
  private logger: Logger;
  private onStateChange?: () => void;
  // 前台用户 Web 操作避让记录：desktopId -> activeUntilTimestamp
  private webUserActiveMap: Map<string, number> = new Map();
  private webYieldTimer: NodeJS.Timeout | null = null;

  constructor(logger: Logger, onStateChange?: () => void) {
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.startWebYieldWatchdog();
  }

  /**
   * 登记前台 Web 用户活跃（避让 60 秒）
   */
  public touchWebUserActive(accountName: string, desktopCode: string, durationSec: number = 60): void {
    const until = Date.now() + durationSec * 1000;
    const isFirstActive = !this.isWebUserActive(desktopCode);
    this.webUserActiveMap.set(desktopCode, until);

    if (isFirstActive) {
      this.logger.addLog('info', `[${accountName}] 检测到前台 Web 直连视窗接入，保活长连主动避让挂起 (${durationSec}s)`);
      this.pauseWorkers(accountName);
    }
  }

  /**
   * 释放前台 Web 用户活跃（页面关闭时立即恢复）
   */
  public releaseWebUserActive(accountName: string, desktopCode: string): void {
    if (this.webUserActiveMap.has(desktopCode)) {
      this.webUserActiveMap.delete(desktopCode);
      this.logger.addLog('info', `[${accountName}] 前台 Web 直连视窗已退出，正在恢复后台保活长连...`);
      this.resumeWorkers(accountName);
    }
  }

  /**
   * 检查指定云电脑当前是否有前台用户在操作
   */
  public isWebUserActive(desktopCode: string): boolean {
    const until = this.webUserActiveMap.get(desktopCode);
    if (!until) return false;
    if (Date.now() > until) {
      this.webUserActiveMap.delete(desktopCode);
      return false;
    }
    return true;
  }

  /**
   * 定时检查避让超时的实例并平滑恢复
   */
  private startWebYieldWatchdog(): void {
    if (this.webYieldTimer) return;
    this.webYieldTimer = setInterval(() => {
      const now = Date.now();
      for (const [desktopCode, until] of this.webUserActiveMap.entries()) {
        if (now > until) {
          this.webUserActiveMap.delete(desktopCode);
          // 寻找对应账号并恢复
          for (const [acc, workers] of this.workers.entries()) {
            const matched = workers.some(w => (w as any).options?.desktop?.desktopCode === desktopCode || (w as any).options?.desktopCode === desktopCode);
            if (matched) {
              this.logger.addLog('info', `[${acc}] 前台 Web 直连避让已超时，正在自动恢复后台保活通道...`);
              this.resumeWorkers(acc);
            }
          }
        }
      }
    }, 5000);
  }

  /**
   * 停止指定账号下的所有保活工作者
   */
  public stopWorkers(accountName: string): void {
    const list = this.workers.get(accountName);
    if (list) {
      for (const w of list) {
        w.stop();
      }
      this.workers.delete(accountName);
    }
  }

  public stopWorkerForDesktop(accountName: string, desktopCodeOrId: string): void {
    const list = this.workers.get(accountName);
    if (!list) return;
    const remaining: KeepAliveWorker[] = [];
    for (const w of list) {
      const d = (w as any).options?.desktop;
      if (d && (d.desktopCode === desktopCodeOrId || String(d.desktopId) === String(desktopCodeOrId))) {
        w.stop();
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
   * 软暂停指定账号下的保活工作者 (让位给挂机任务或前台直连)
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
   * 恢复指定账号下的保活工作者
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
    if (this.webYieldTimer) {
      clearInterval(this.webYieldTimer);
      this.webYieldTimer = null;
    }
    for (const [acc, workers] of this.workers.entries()) {
      for (const w of workers) {
        try {
          w.stop();
        } catch {}
      }
    }
    this.workers.clear();
  }

  /**
   * 核心同步调度：按最新云电脑列表智能创建、销毁、维持保活连接
   */
  public async syncWorkersForAccount(
    accountName: string,
    client: CtYunClient,
    desktops: Desktop[],
    desktopStates: ManagedDesktopState[],
    isManualShutdown?: (desktopId: string) => boolean,
  ): Promise<void> {
    if (!client.loginInfo) return;

    // 检查是否已经存在运行中的工作者，避免重复销毁重建
    const existingWorkers = this.workers.get(accountName) || [];
    if (existingWorkers.length > 0 && existingWorkers.every(w => (w as any).isRunning)) {
      return;
    }

    // 清理旧工作者
    this.stopWorkers(accountName);

    const newWorkers: KeepAliveWorker[] = [];

    for (let i = 0; i < desktops.length; i++) {
      const d = desktops[i];
      const state = desktopStates[i];

      // 若用户主动手动关机，则严格跳过自动开机与保活建立
      const dCode = d.desktopCode || d.desktopId;
      if (isManualShutdown && isManualShutdown(dCode)) {
        if (state) {
          state.status = 'stopped';
          state.useStatusText = '已关机';
        }
        this.logger.addLog('info', `[${accountName}] 云电脑 [${d.desktopName || dCode}] 处于手动关机锁定状态，跳过自动唤醒`);
        continue;
      }

      // 若云电脑未处于运行中（已关机/离线等），先自动下发官方开机指令并轮询等待开机就绪
      const isRunning = d.useStatusText === '运行中' || d.useStatusText === '离线运行';
      if (!isRunning) {
        this.logger.addLog(
          'warn',
          `[${accountName}] 当前状态: [${d.useStatusText}]，正在下发自动开机指令...`,
        );
        try {
          await client.operateDesktop(d.desktopId, 'on');
        } catch (e: any) {
          this.logger.addLog('warn', `[${accountName}] 自动开机提示: ${e.message}`);
        }

        // 异步等待云电脑开机完成（轮询检测官方状态，最多等待 5 分钟）
        this.logger.addLog('info', `[${accountName}] 等待云电脑开机就绪中 (最长 5 分钟)...`);
        let ready = false;
        for (let waitSec = 0; waitSec < 60; waitSec++) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const latestList = await client.getDesktopList();
            const cur = latestList.find((item) => item.desktopId === d.desktopId);
            if (cur && (cur.useStatusText === '运行中' || cur.useStatusText === '离线运行')) {
              d.useStatusText = cur.useStatusText;
              ready = true;
              this.logger.addLog('success', `[${accountName}] 云电脑已成功开机`);
              break;
            }
          } catch {}
        }
        if (!ready) {
          this.logger.addLog('warn', `[${accountName}] 云电脑开机仍在进行中，稍后将自动接入保活`);
        }
      }

      let info: DesktopInfo | null = null;
      // 若刚触发开机或关机冷备，官方桌面可能需要数秒启动初始化，进行优雅重试
      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          info = await client.connectDesktop(d);
          if (info && info.clinkLvsOutHost) break;
        } catch (e: any) {
          if (attempt === maxRetries) {
            this.logger.addLog('warn', `[${accountName}] 暂时未能获取到云电脑连接信道，将在下个周期自动重试`);
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

        // 如果当前前台正在通过 Web 直连操控该电脑，创建后直接处于 pause 状态
        const isWebActive = this.isWebUserActive(d.desktopCode || d.desktopId);

        const worker = new KeepAliveWorker({
          accountName,
          desktop: d,
          desktopInfo: info,
          loginInfo: client.loginInfo,
          deviceCode: client.getDeviceCode(),
          onRefreshInfo: async (): Promise<DesktopInfo> => {
            return await client.connectDesktop(d);
          },
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
        });

        worker.start();
        newWorkers.push(worker);

        if (isWebActive) {
          worker.pause();
        }
      } catch (err: any) {
        this.logger.addLog(
          'error',
          `[${accountName}] 连接建立失败: ${err.message}`,
        );
      }
    }

    this.workers.set(accountName, newWorkers);
  }
}
