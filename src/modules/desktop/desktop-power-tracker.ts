import type { CtYunClient } from '../../core/client.js';
import type { ManagedDesktopState } from '../../types/index.js';
import type { Logger } from '../../core/logger.js';

export const POWER_TRACKING_INTERVAL_MS = 20000;  // 电源操作后的轮询追踪周期: 20 秒
export const POWER_TRACKING_MAX_ROUNDS = 15;      // 电源状态轮询最大轮次 (15 * 20s = 5 分钟超时)

export interface DesktopPowerDelegate {
  getClient(accountName: string): CtYunClient;
  hasAccount(accountName: string): boolean;
  getDesktopState(accountName: string, desktopId: string): ManagedDesktopState | undefined;
  notifyStatusChange(): void;
  onPowerOnSuccess(accountName: string): void;
  onPowerTimeout(accountName: string): void;
}

export class DesktopPowerTracker {
  private powerTrackingTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private logger: Logger,
    private delegate: DesktopPowerDelegate,
  ) {}

  public trackDesktopStatusAfterPower(
    accountName: string,
    desktopId: string,
    operation: 'on' | 'shutdown' | 'reset',
  ): void {
    const trackingKey = `${accountName}:${desktopId}`;
    const existingTimer = this.powerTrackingTimers.get(trackingKey);
    if (existingTimer) {
      clearInterval(existingTimer);
      this.powerTrackingTimers.delete(trackingKey);
    }

    const client = this.delegate.getClient(accountName);
    let attempts = 0;
    const maxAttempts = POWER_TRACKING_MAX_ROUNDS;

    const timer = setInterval(async () => {
      attempts++;
      try {
        if (!this.delegate.hasAccount(accountName)) {
          clearInterval(timer);
          this.powerTrackingTimers.delete(trackingKey);
          return;
        }

        const target = this.delegate.getDesktopState(accountName, desktopId);
        const objType = typeof target?.objType === 'number' ? target.objType : 0;
        const stateInfo = await client.getDesktopState(desktopId, objType);
        let realStatusText = stateInfo?.useStatusText;

        if (!realStatusText) {
          const list = await client.getDesktopList();
          const current = list.find((d) => String(d.desktopCode) === String(desktopId) || String(d.desktopId) === String(desktopId));
          realStatusText = current?.useStatusText;
        }

        if (realStatusText && target) {
          const dName = target.desktopName || target.computerName || target.name || desktopId;
          const dPrefix = dName ? `${accountName} - ${dName}` : accountName;
          target.useStatusText = realStatusText;

          if (operation === 'on' || operation === 'reset') {
            if (realStatusText === '运行中') {
              clearInterval(timer);
              this.powerTrackingTimers.delete(trackingKey);
              target.status = 'connecting';
              this.logger.addLog('success', `[${dPrefix}] 云电脑已成功开机，正在接入保活...`);
              this.delegate.notifyStatusChange();
              // 开机成功后通知上层就绪处理（如缓冲后接入 WS 保活）
              this.delegate.onPowerOnSuccess(accountName);
              return;
            }
          } else if (operation === 'shutdown') {
            if (realStatusText === '已关机' || realStatusText === '关机') {
              clearInterval(timer);
              this.powerTrackingTimers.delete(trackingKey);
              target.status = 'stopped';
              this.logger.addLog('info', `[${dPrefix}] 云电脑已安全关机，已锁定保活防止误唤醒`);
              this.delegate.notifyStatusChange();
              return;
            }
          }
          this.delegate.notifyStatusChange();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.addLog('warn', `[${accountName}] 电源状态轮询跟踪网络异常: ${msg}`);
      }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        this.powerTrackingTimers.delete(trackingKey);
        const target = this.delegate.getDesktopState(accountName, desktopId);
        const dName = target?.desktopName || target?.computerName || target?.name || desktopId;
        const dPrefix = dName ? `${accountName} - ${dName}` : accountName;
        this.logger.addLog('warn', `[${dPrefix}] 电源操作追踪已达 5 分钟上限，已结束实时追踪`);
        this.delegate.onPowerTimeout(accountName);
      }
    }, POWER_TRACKING_INTERVAL_MS);

    this.powerTrackingTimers.set(trackingKey, timer);
  }

  public clearTimer(accountName: string, desktopId: string): void {
    const trackingKey = `${accountName}:${desktopId}`;
    const timer = this.powerTrackingTimers.get(trackingKey);
    if (timer) {
      clearInterval(timer);
      this.powerTrackingTimers.delete(trackingKey);
    }
  }

  public renameAccount(oldName: string, newName: string): void {
    for (const [key, timer] of Array.from(this.powerTrackingTimers.entries())) {
      if (key.startsWith(`${oldName}:`)) {
        const desktopId = key.slice(oldName.length + 1);
        this.powerTrackingTimers.delete(key);
        this.powerTrackingTimers.set(`${newName}:${desktopId}`, timer);
      }
    }
  }

  public clearForAccount(accountName: string): void {
    for (const [key, timer] of Array.from(this.powerTrackingTimers.entries())) {
      if (key.startsWith(`${accountName}:`)) {
        clearInterval(timer);
        this.powerTrackingTimers.delete(key);
      }
    }
  }

  public clearAll(): void {
    for (const timer of this.powerTrackingTimers.values()) {
      clearInterval(timer);
    }
    this.powerTrackingTimers.clear();
  }
}
