import { normalizeUseStatusText, type CtYunClient } from '../../ctyun/client.js';
import { errorText } from '../../infra/http.js';
import type { ManagedDesktopState } from '../../types.js';
import type { Logger } from '../../infra/logger.js';

const TRACK_INTERVAL_MS = 20000; // 电源操作后轮询周期
const TRACK_MAX_ROUNDS = 15; // 最大轮次 (15 * 20s = 5 分钟超时)

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
    const maxAttempts = TRACK_MAX_ROUNDS;

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
          target.useStatusText = realStatusText;
          const statusKind = normalizeUseStatusText(realStatusText);

          if (operation === 'on' || operation === 'reset') {
            if (statusKind === 'running') {
              clearInterval(timer);
              this.powerTrackingTimers.delete(trackingKey);
              target.status = 'connecting';
              this.logger.addLog('success', '云电脑已开机，正在接入保活', { source: 'power', account: accountName, desktop: dName });
              this.delegate.notifyStatusChange();
              // 开机成功后通知上层就绪处理（如缓冲后接入 WS 保活）
              this.delegate.onPowerOnSuccess(accountName);
              return;
            }
          } else if (operation === 'shutdown') {
            if (statusKind === 'stopped') {
              clearInterval(timer);
              this.powerTrackingTimers.delete(trackingKey);
              target.status = 'stopped';
              this.logger.addLog('info', '云电脑已安全关机，保活已锁定防误唤醒', { source: 'power', account: accountName, desktop: dName });
              this.delegate.notifyStatusChange();
              return;
            }
          }
          this.delegate.notifyStatusChange();
        }
      } catch (err) {
        const msg = errorText(err);
        this.logger.addLog('warn', `电源状态轮询异常: ${msg}`, { source: 'power', account: accountName });
      }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        this.powerTrackingTimers.delete(trackingKey);
        const target = this.delegate.getDesktopState(accountName, desktopId);
        const dName = target?.desktopName || target?.computerName || target?.name || desktopId;
        this.logger.addLog('warn', '电源操作追踪已达 5 分钟上限，结束追踪', { source: 'power', account: accountName, desktop: dName });
        this.delegate.onPowerTimeout(accountName);
      }
    }, TRACK_INTERVAL_MS);

    this.powerTrackingTimers.set(trackingKey, timer);
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
