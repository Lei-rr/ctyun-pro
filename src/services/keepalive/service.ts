import { EventEmitter } from 'events';
import { errorText } from '../../infra/http.js';
import { normalizeDesktopState, type CtYunClient, type Desktop, type DesktopInfo } from '../../ctyun/client.js';
import { KeepAliveWorker } from './worker.js';
import type { Logger } from '../../infra/logger.js';
import type { ManagedDesktopState } from '../../types.js';
export type { ManagedDesktopState };

/**
 * 现代化静默保活服务模块 (Keepalive Service)
 *
 * 核心设计（三大极简控制原则）：
 * 1. 保活与任务：WebSocket 长连接维持 30 秒客户端活跃心跳；
 * 2. 项目内远程桌面：进入 /desktop/:desktopCode 时由 ProfileManager 暂停保活，关闭后 20s 防抖精准恢复；
 * 3. 官方客户端避让：收到 4001（Type 119）保活立即断开让位并触发 paused 事件，由看门狗探针检测自愈。
 */
export class KeepaliveService extends EventEmitter {
  private workers: Map<string, KeepAliveWorker[]> = new Map();
  private logger: Logger;
  private onStateChange?: () => void;
  // 同账号防并发 Worker 同步锁
  private syncWorkersPromises: Map<string, Promise<void>> = new Map();

  constructor(logger: Logger, onStateChange?: () => void) {
    super();
    this.logger = logger;
    this.onStateChange = onStateChange;
  }

  /**
   * 停止指定账号下的所有保活 Worker
   */
  public stopWorkers(accountName: string): void {
    const list = this.workers.get(accountName);
    if (list) {
      for (const w of list) {
        try {
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
      const d = w.options?.desktop;
      if (d && (d.desktopCode === desktopCodeOrId || String(d.desktopId) === String(desktopCodeOrId))) {
        try {
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
   * 暂停单台云电脑的保活 Worker
   */
  public pauseWorkerForDesktop(accountName: string, desktopCodeOrId: string): boolean {
    const list = this.workers.get(accountName);
    if (!list || list.length === 0) return false;

    for (const w of list) {
      const d = w.options?.desktop;
      const targetKey = d?.desktopCode || String(d?.desktopId || '');
      if (targetKey === desktopCodeOrId || String(d?.desktopId) === desktopCodeOrId) {
        try {
          w.pause();
          return true;
        } catch {}
      }
    }
    return false;
  }

  /**
   * 恢复单台云电脑的保活 Worker
   */
  public async resumeWorkerForDesktop(accountName: string, desktopCodeOrId: string): Promise<boolean> {
    const list = this.workers.get(accountName);
    if (!list || list.length === 0) return false;

    for (const w of list) {
      const d = w.options?.desktop;
      const targetKey = d?.desktopCode || String(d?.desktopId || '');
      if (targetKey === desktopCodeOrId || String(d?.desktopId) === desktopCodeOrId) {
        const dName = d?.desktopName || d?.computerName || d?.name || targetKey;
        const dPrefix = dName ? `${accountName} - ${dName}` : accountName;

        this.logger.addLog('info', `[${dPrefix}] 正在申请全新凭据并唤醒恢复保活长连接...`);
        w.needsFreshTicket = true;
        w.resume();
        return true;
      }
    }
    return false;
  }

  /**
   * 停止全部保活工作者
   */
  public stopAll(): void {
    for (const [, workers] of this.workers.entries()) {
      for (const w of workers) {
        try {
          w.stop();
        } catch {}
      }
    }
    this.workers.clear();
  }

  /**
   * 核心保活调度：按最新云电脑列表智能创建、维持受控保活连接
   */
  public async syncWorkersForAccount(
    accountName: string,
    client: CtYunClient,
    desktops: Desktop[],
    desktopStates: ManagedDesktopState[],
    isManualShutdown?: (desktopId: string) => boolean,
    isWebActive?: (desktopId: string) => boolean,
  ): Promise<void> {
    if (!client.loginInfo) return;

    const existingPromise = this.syncWorkersPromises.get(accountName);
    if (existingPromise) {
      return existingPromise;
    }

    const task = (async () => {
      try {
        await this._doSyncWorkersForAccount(accountName, client, desktops, desktopStates, isManualShutdown, isWebActive);
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
    isWebActive?: (desktopId: string) => boolean,
  ): Promise<void> {
    if (!client.loginInfo) return;

    // 期望建立 Worker 的桌面数 (排除手动关机与前台 Web 避让中的桌面，避免反复重建抖动)
    const expectedCount = desktops.filter((d) => {
      const dCode = d.desktopCode || d.desktopId;
      if (isManualShutdown && isManualShutdown(dCode)) return false;
      if (isWebActive && (isWebActive(dCode) || (d.desktopId && isWebActive(String(d.desktopId))))) return false;
      return true;
    }).length;

    const existingWorkers = this.workers.get(accountName) || [];

    // 无需保活的桌面 (全部手动关机或前台避让中) 且当前无 Worker，直接返回
    if (expectedCount === 0 && existingWorkers.length === 0) {
      return;
    }

    // 检查是否所有应保活 Worker 都在健康且活跃运行 (未被暂停且处于运行中)
    const allActive =
      existingWorkers.length === expectedCount &&
      existingWorkers.length > 0 &&
      existingWorkers.every((w) => w.isRunning && !w.isPaused);

    if (allActive) {
      return;
    }

    this.stopWorkers(accountName);
    const newWorkers: KeepAliveWorker[] = [];

    for (let i = 0; i < desktops.length; i++) {
      const d = desktops[i];
      const state = desktopStates[i];

      const dCode = d.desktopCode || d.desktopId;
      const dName = d.desktopName || d.computerName || d.name || dCode;
      const dPrefix = dName ? `${accountName} - ${dName}` : accountName;

      // 手动关机锁定拦截
      if (isManualShutdown && isManualShutdown(dCode)) {
        if (state) {
          state.status = 'stopped';
          state.useStatusText = '已关机';
        }
        this.logger.addLog('info', `[${dPrefix}] 处于手动关机锁定状态，跳过自动唤醒与保活`);
        continue;
      }

      // 前台 Web 用户避让拦截：不重建保活连接，避免顶掉正在浏览器直连操作的用户
      if (isWebActive && (isWebActive(dCode) || (d.desktopId && isWebActive(String(d.desktopId))))) {
        if (state) {
          state.status = 'paused';
          state.useStatusText = '前台操作中';
        }
        this.logger.addLog('info', `[${dPrefix}] 前台 Web 用户正在操作，跳过后台保活建立（让位中）`);
        continue;
      }

      // 开机/唤醒检测与自愈指令
      let isRunning = d.useStatusText === '运行中' || d.useStatusText === '离线运行';
      if (!isRunning) {
        const isSleep = (d.useStatusText || '').includes('休眠') || (d.useStatusText || '').includes('睡眠');
        const isOff = (d.useStatusText || '').includes('关机') || (d.useStatusText || '').includes('已停止');
        let cmdSent = false;

        if (isSleep) {
          this.logger.addLog('info', `[${dPrefix}] 云电脑处于休眠状态，正在发送唤醒指令...`);
          try {
            await client.operateDesktop(d.desktopId, 'awake', d.objType);
            this.logger.addLog('info', `[${dPrefix}] 唤醒指令已发送，等待系统启动就绪 (最长等待 5 分钟)`);
            cmdSent = true;
          } catch (e) {
            const err = errorText(e);
            this.logger.addLog('error', `[${dPrefix}] 唤醒失败: ${err}`);
          }
        } else if (isOff) {
          this.logger.addLog('info', `[${dPrefix}] 云电脑处于关机状态，正在发送开机指令...`);
          try {
            await client.operateDesktop(d.desktopId, 'on', d.objType);
            this.logger.addLog('info', `[${dPrefix}] 开机指令已发送，等待系统启动就绪 (最长等待 5 分钟)`);
            cmdSent = true;
          } catch (e) {
            const err = errorText(e);
            this.logger.addLog('error', `[${dPrefix}] 开机失败: ${err}`);
          }
        }

        if (cmdSent) {
          if (state) {
            state.status = 'connecting';
            state.useStatusText = isSleep ? '唤醒中' : '启动中';
            this.onStateChange?.();
          }

          const MAX_ATTEMPTS = 10;
          const POLL_INTERVAL = 30000;
          let ready = false;

          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
            try {
              const stateRes = await client.getDesktopState(d.desktopId, d.objType);
              let statusText = stateRes?.useStatusText || '';
              const desktopState = (stateRes?.desktopState || '').toUpperCase();
              const useStatusCode = String(stateRes?.useStatus || '');

              if (!statusText && !desktopState) {
                const list = await client.getDesktopList();
                const current = list.find((item) => String(item.desktopCode) === String(d.desktopCode) || String(item.desktopId) === String(d.desktopId));
                statusText = current?.useStatusText || '';
              }

              // 官方 desktopState 就绪态归一化为 running；useStatus 20/25 均代表实例在线
              const normalizedState = normalizeDesktopState(desktopState);
              const isReady =
                statusText === '运行中' ||
                statusText === '离线运行' ||
                normalizedState === 'running' ||
                desktopState === 'RUNNING' ||
                useStatusCode === '20' ||
                useStatusCode === '25';

              if (isReady) {
                ready = true;
                if (statusText) d.useStatusText = statusText;
                if (state) {
                  state.useStatusText = statusText || '运行中';
                  this.onStateChange?.();
                }
                this.logger.addLog('info', `[${dPrefix}] 云电脑已启动就绪 (状态: ${statusText || '运行中'})，开始建立保活长连接`);
                break;
              } else {
                this.logger.addLog(
                  'info',
                  `[${dPrefix}] 云电脑启动中 (第 ${attempt}/${MAX_ATTEMPTS} 次检测，当前状态: ${statusText || desktopState || '开机中'})，等待 30s 后复测...`
                );
              }
            } catch (pollErr) {
              const errMsg = errorText(pollErr);
              this.logger.addLog('warn', `[${dPrefix}] 状态轮询检测异常 (第 ${attempt}/${MAX_ATTEMPTS} 次): ${errMsg}`);
            }
          }

          if (!ready) {
            this.logger.addLog('warn', `[${dPrefix}] 云电脑启动等待超时 (已等待 5 分钟)，稍后看门狗探针将自动重新巡检`);
            continue;
          }
        }
      }

      // 获取保活长连接凭证 (Ticket)
      let info: DesktopInfo | null = null;
      try {
        this.logger.addLog('info', `[${dPrefix}] 正在向天翼云调度中心申请长连接凭据 (Ticket)...`);
        info = await client.connectDesktop(d);
      } catch (err) {
        const msg = errorText(err);
        this.logger.addLog('error', `[${dPrefix}] 申请长连接凭据失败: ${msg}`);
      }

      if (!info) {
        continue;
      }

      try {
        d.desktopInfo = info;

        const workerInstance = new KeepAliveWorker({
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
              if (status === 'paused') {
                this.emit('desktop:paused', { accountName, desktopId: d.desktopId, desktopCode: d.desktopCode });
              }
            }
            this.onStateChange?.();
          },
          onPreempted: (code, reason) => {
            this.emit('desktop:paused', { accountName, desktopId: d.desktopId, desktopCode: d.desktopCode });
            this.emit('worker:preempted', { accountName, desktopCode: d.desktopCode, desktopId: d.desktopId, code, reason });
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
            // 关键自愈：强制要求官方签发全新凭据 (forceFresh=true)
            const newInfo = await client.connectDesktop(d, 0, true);
            if (newInfo && newInfo.clinkLvsOutHost) {
              d.desktopInfo = newInfo;
              return newInfo;
            }
            throw new Error('调度中心未返回有效网关凭据');
          },
        });

        workerInstance.start();
        newWorkers.push(workerInstance);
      } catch (err) {
        const msg = errorText(err);
        this.logger.addLog('error', `[${dPrefix}] 保活连接建立失败: ${msg}`);
      }
    }

    this.workers.set(accountName, newWorkers);
  }
}