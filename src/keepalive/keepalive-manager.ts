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

  constructor(logger: Logger, onStateChange?: () => void) {
    this.logger = logger;
    this.onStateChange = onStateChange;
  }

  /**
   * 停止指定账号下的所有保活工作者
   */
  public stopWorkers(accountName: string): void {
    const existing = this.workers.get(accountName) || [];
    for (const w of existing) {
      try {
        w.stop();
      } catch {}
    }
    this.workers.delete(accountName);
  }

  /**
   * 停止全部保活工作者
   */
  public stopAll(): void {
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
   * 为账号名下的所有云电脑启动最小 CLINK 保活守护
   */
  public async syncWorkersForAccount(
    accountName: string,
    client: CtYunClient,
    desktops: Desktop[],
    desktopStates: ManagedDesktopState[],
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

      // 若云电脑未处于运行中（已关机/离线等），先自动下发官方开机指令并轮询等待开机就绪
      const isRunning = d.useStatusText === '运行中' || d.useStatusText === '离线运行';
      if (!isRunning) {
        this.logger.addLog(
          'warn',
          `[${accountName}][${d.desktopCode || d.desktopId}] 当前状态: [${d.useStatusText}]，正在下发自动开机指令...`,
        );
        try {
          await client.operateDesktop(d.desktopId, 'on');
        } catch (e: any) {
          this.logger.addLog('warn', `[${accountName}] 自动开机提示: ${e.message}`);
        }

        // 异步等待云电脑开机完成（轮询检测官方状态，最多等待 5 分钟）
        this.logger.addLog('info', `[${accountName}][${d.desktopCode || d.desktopId}] 等待云电脑开机就绪中 (最长 5 分钟)...`);
        let ready = false;
        for (let waitSec = 0; waitSec < 60; waitSec++) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const latestList = await client.getDesktopList();
            const cur = latestList.find((item) => item.desktopId === d.desktopId);
            if (cur && (cur.useStatusText === '运行中' || cur.useStatusText === '离线运行')) {
              d.useStatusText = cur.useStatusText;
              ready = true;
              this.logger.addLog('success', `[${accountName}][${d.desktopCode || d.desktopId}] 云电脑已成功开机`);
              break;
            }
          } catch {}
        }
        if (!ready) {
          this.logger.addLog('warn', `[${accountName}][${d.desktopCode || d.desktopId}] 云电脑开机仍在进行中，稍后将自动接入保活`);
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
      } catch (err: any) {
        this.logger.addLog(
          'error',
          `[${accountName}][${d.desktopCode || d.desktopId}] 连接建立失败: ${err.message}`,
        );
      }
    }

    this.workers.set(accountName, newWorkers);
  }
}
