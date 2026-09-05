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

      if (d.useStatusText !== '运行中') {
        this.logger.addLog(
          'warn',
          `[${accountName}][${d.desktopCode || d.desktopId}] 状态: [${d.useStatusText}]，天翼云正在触发自动开机，准备握手连接...`,
        );
      }

      try {
        const info = await client.connectDesktop(d.desktopId);
        d.desktopInfo = info;

        const worker = new KeepAliveWorker({
          accountName,
          desktop: d,
          desktopInfo: info,
          loginInfo: client.loginInfo,
          deviceCode: client.getDeviceCode(),
          onRefreshInfo: async (desktopId: string): Promise<DesktopInfo> => {
            return await client.connectDesktop(desktopId);
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
