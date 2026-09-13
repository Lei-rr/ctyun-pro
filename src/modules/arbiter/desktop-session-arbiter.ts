import { EventEmitter } from 'events';
import type { Logger } from '../../core/logger.js';

export type LeasePurpose = 'idle' | 'keepalive' | 'hang' | 'web_direct';

export interface ExternalYieldInfo {
  until: number;
  reason: string;
  triggeredAt: number;
  durationMinutes: number;
  timer?: NodeJS.Timeout;
}

export interface LeaseHolder {
  purpose: LeasePurpose;
  ownerId: string;
  acquiredAt: number;
  expiresAt?: number;
  releaseCallback?: () => Promise<void> | void;
}

/**
 * 桌面会话排他仲裁器 (Desktop Session Arbiter)
 *
 * 核心设计原则：
 * 1. 单桌面单租约 (Single Active Lease per Desktop)：
 *    全系统内任意一台云电脑 (desktopId)，同一时刻至多分配一份长连接租约。
 * 2. 优先级抢占与避让 (Preemption & Graceful Yield)：
 *    web_direct (前台直连) > hang (挂机任务) > keepalive (常驻低频保活)。
 * 3. 无死锁租约保证 (Deadlock-free Lease Acquisition)：
 *    申请租约时自动调度冲突方的优雅退出，并提供超时强制解绑兜底。
 */
export class DesktopSessionArbiter extends EventEmitter {
  private static instance: DesktopSessionArbiter | null = null;
  // desktopId (string) -> 当前活跃持约者
  private activeLeases: Map<string, LeaseHolder> = new Map();
  // desktopId (string) -> 外部官方客户端主动避让锁信息
  private externalYields: Map<string, ExternalYieldInfo> = new Map();
  // desktopId -> 排队与抢占互斥锁 (Promise chain)
  private leaseLocks: Map<string, Promise<any>> = new Map();
  private logger?: Logger;

  private constructor() {
    super();
  }

  public static getInstance(): DesktopSessionArbiter {
    if (!DesktopSessionArbiter.instance) {
      DesktopSessionArbiter.instance = new DesktopSessionArbiter();
    }
    return DesktopSessionArbiter.instance;
  }

  public setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /**
   * 检查持约者是否已过期并自动清理
   */
  private checkAndEvictExpired(key: string): LeaseHolder | undefined {
    const holder = this.activeLeases.get(key);
    if (!holder) return undefined;
    if (holder.expiresAt && Date.now() > holder.expiresAt) {
      this.activeLeases.delete(key);
      this.emit('lease:released', { desktopId: key, purpose: holder.purpose, ownerId: holder.ownerId });
      this.logger?.addLog(
        'info',
        `[桌面仲裁器] 桌面 ${key} 租约已超时自然过期并释放 (${holder.purpose}:${holder.ownerId})`,
      );
      return undefined;
    }
    return holder;
  }

  /**
   * 触发向外部客户端主动避让 (Yield to External Client)
   * 当网关下发 4001 / conflict 或 Type 119/120/137 客户端冲突挤占信号时调用
   * @param desktopId 云电脑 ID 或设备编码
   * @param durationMinutes 避让持续时间 (分钟，默认 5 分钟)
   * @param reason 避让原因
   */
  public async yieldToExternal(
    desktopId: string,
    durationMinutes: number = 5,
    reason: string = '外部官方客户端接入',
  ): Promise<void> {
    const key = String(desktopId);
    const now = Date.now();
    const duration = Math.max(1, durationMinutes);
    const until = now + duration * 60 * 1000;
    const timeStr = new Date(until).toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });

    const existing = this.externalYields.get(key);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.clearYield(key);
    }, duration * 60 * 1000);
    if (timer.unref) timer.unref();

    this.externalYields.set(key, {
      until,
      reason,
      triggeredAt: now,
      durationMinutes: duration,
      timer,
    });

    this.logger?.addLog(
      'warn',
      `[桌面仲裁器] 桌面 ${desktopId} 检测到外部官方客户端接入，系统主动避让 ${duration} 分钟 (至 ${timeStr})，暂停长连接与自动化任务`,
    );

    this.emit('yield:triggered', { desktopId: key, until, reason });

    // 若当前持有自动化租约 (keepalive 或 hang)，立即通知持约者让位释放
    const current = this.checkAndEvictExpired(key);
    if (current && (current.purpose === 'keepalive' || current.purpose === 'hang')) {
      if (current.releaseCallback) {
        try {
          await Promise.race([
            Promise.resolve(current.releaseCallback()),
            new Promise((_, reject) => setTimeout(() => reject(new Error('避让释放旧租约超时')), 3000)),
          ]);
        } catch (e: any) {
          this.logger?.addLog('warn', `[桌面仲裁器] 桌面 ${desktopId} 避让释放旧租约异常: ${e.message}`);
        }
      }
      this.activeLeases.delete(key);
      this.emit('lease:released', { desktopId: key, purpose: current.purpose, ownerId: current.ownerId });
    }
  }

  /**
   * 查询指定桌面的外部避让状态
   */
  public getYieldStatus(desktopId: string): { yielding: boolean; remainingSeconds: number; reason?: string } {
    const key = String(desktopId);
    const info = this.externalYields.get(key);
    if (!info) return { yielding: false, remainingSeconds: 0 };
    const now = Date.now();
    if (now >= info.until) {
      this.externalYields.delete(key);
      this.emit('yield:expired', { desktopId: key });
      return { yielding: false, remainingSeconds: 0 };
    }
    return {
      yielding: true,
      remainingSeconds: Math.ceil((info.until - now) / 1000),
      reason: info.reason,
    };
  }

  /**
   * 主动解除外部避让状态 (如用户在 Web 前端显式连接)
   */
  public clearYield(desktopId: string): void {
    const key = String(desktopId);
    const existing = this.externalYields.get(key);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      this.externalYields.delete(key);
      this.emit('yield:cleared', { desktopId: key });
      this.logger?.addLog('info', `[桌面仲裁器] 桌面 ${desktopId} 外部避让状态已主动解除`);
    }
  }

  /**
   * 申请桌面长连接独占租约
   * @param desktopId 目标云电脑 ID
   * @param purpose 申请用途
   * @param ownerId 申请者标识 (如账号名或任务ID)
   * @param onRelease 当前持约者被更高优先级抢占时的释放回调
   * @param ttlMs 租约有效存活毫秒数（可选，如前台直连超时防护）
   * @returns 是否成功获取租约
   */
  public async acquireLease(
    desktopId: string,
    purpose: LeasePurpose,
    ownerId: string,
    onRelease?: () => Promise<void> | void,
    ttlMs?: number,
  ): Promise<boolean> {
    const key = String(desktopId);

    // 获取该桌面的排他串行执行链，杜绝并发竞争申请
    const prevLock = this.leaseLocks.get(key) || Promise.resolve();

    let releaseLock: () => void = () => {};
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const thisLock = prevLock.then(() => newLock);
    this.leaseLocks.set(key, thisLock);

    try {
      await prevLock;

      // 外部官方客户端主动避让期拦截
      const yieldStatus = this.getYieldStatus(key);
      if (yieldStatus.yielding) {
        if (purpose === 'web_direct') {
          // 用户在 Web 控制台人工发起直连，最高优先级直通，主动解除外部避让锁
          this.logger?.addLog(
            'info',
            `[桌面仲裁器] 用户发起 Web 控制台直连，解除桌面 ${desktopId} 的外部避让锁`,
          );
          this.clearYield(key);
        } else {
          this.logger?.addLog(
            'info',
            `[桌面仲裁器] 桌面 ${desktopId} 正处于外部官方客户端主动避让期 (剩余 ${yieldStatus.remainingSeconds}秒，原因: ${yieldStatus.reason})，拒绝申请 ${purpose} 租约`,
          );
          return false;
        }
      }

      // 检查现有持约者是否已过期
      const currentHolder = this.checkAndEvictExpired(key);
      if (currentHolder) {
        // 同一主体重复声明相同租约，直接续租并刷新过期时间
        if (currentHolder.purpose === purpose && currentHolder.ownerId === ownerId) {
          currentHolder.releaseCallback = onRelease || currentHolder.releaseCallback;
          currentHolder.expiresAt = ttlMs ? Date.now() + ttlMs : undefined;
          return true;
        }

        // 优先级比对
        const priorityOrder: Record<LeasePurpose, number> = {
          idle: 0,
          keepalive: 1,
          hang: 2,
          web_direct: 3,
        };

        const currentPriority = priorityOrder[currentHolder.purpose] || 0;
        const incomingPriority = priorityOrder[purpose] || 0;

        if (incomingPriority < currentPriority) {
          this.logger?.addLog(
            'warn',
            `[桌面仲裁器] 桌面 ${desktopId} 已被高优先级任务 (${currentHolder.purpose}:${currentHolder.ownerId}) 独占，拒绝低优先级申请 (${purpose}:${ownerId})`,
          );
          return false;
        }

        // 正在被同级或低优先级占用：通知旧持约者优雅释放
        this.logger?.addLog(
          'info',
          `[桌面仲裁器] 桌面 ${desktopId} 租约转交：${currentHolder.purpose}:${currentHolder.ownerId} -> ${purpose}:${ownerId}`,
        );

        if (currentHolder.releaseCallback) {
          try {
            await Promise.race([
              Promise.resolve(currentHolder.releaseCallback()),
              new Promise((_, reject) => setTimeout(() => reject(new Error('释放租约超时')), 3000)),
            ]);
          } catch (e: any) {
            this.logger?.addLog('warn', `[桌面仲裁器] 桌面 ${desktopId} 旧租约释放异常: ${e.message}`);
          }
        }
      }

      // 分配新租约
      const newHolder: LeaseHolder = {
        purpose,
        ownerId,
        acquiredAt: Date.now(),
        expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
        releaseCallback: onRelease,
      };
      this.activeLeases.set(key, newHolder);

      this.emit('lease:acquired', { desktopId: key, purpose, ownerId });
      return true;
    } finally {
      releaseLock();
      if (this.leaseLocks.get(key) === thisLock) {
        this.leaseLocks.delete(key);
      }
    }
  }

  /**
   * 释放桌面租约
   */
  public async releaseLease(desktopId: string, purpose: LeasePurpose, ownerId: string): Promise<void> {
    const key = String(desktopId);
    const current = this.activeLeases.get(key);
    if (!current) return;

    if (current.ownerId === ownerId && current.purpose === purpose) {
      this.activeLeases.delete(key);
      this.emit('lease:released', { desktopId: key, purpose, ownerId });
      this.logger?.addLog('info', `[桌面仲裁器] 桌面 ${desktopId} 租约已主动释放 (${purpose}:${ownerId})`);
    }
  }

  /**
   * 查询当前桌面持约者状态
   */
  public getLease(desktopId: string): LeaseHolder | undefined {
    return this.checkAndEvictExpired(String(desktopId));
  }

  /**
   * 获取系统中所有正在活跃中的租约快照
   */
  public getActiveLeases(): Record<string, { purpose: LeasePurpose; ownerId: string; acquiredAt: number }> {
    const result: Record<string, { purpose: LeasePurpose; ownerId: string; acquiredAt: number }> = {};
    for (const key of Array.from(this.activeLeases.keys())) {
      const val = this.checkAndEvictExpired(key);
      if (val) {
        result[key] = {
          purpose: val.purpose,
          ownerId: val.ownerId,
          acquiredAt: val.acquiredAt,
        };
      }
    }
    return result;
  }

  /**
   * 判定指定桌面当前是否正处于挂机、前台直连或外部客户端避让期
   */
  public isBusy(desktopId: string): boolean {
    const yieldStatus = this.getYieldStatus(desktopId);
    if (yieldStatus.yielding) return true;
    const holder = this.checkAndEvictExpired(String(desktopId));
    return holder ? holder.purpose === 'hang' || holder.purpose === 'web_direct' : false;
  }

  /**
   * 优雅清理所有持约记录与避让锁
   */
  public async clearAll(): Promise<void> {
    for (const [dId, holder] of this.activeLeases.entries()) {
      if (holder.releaseCallback) {
        try {
          await holder.releaseCallback();
        } catch {}
      }
    }
    for (const info of this.externalYields.values()) {
      if (info.timer) clearTimeout(info.timer);
    }
    this.activeLeases.clear();
    this.externalYields.clear();
    this.leaseLocks.clear();
  }
}
