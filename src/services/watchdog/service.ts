import { ProfileManager } from '../../manager.js';
import { errorText } from '../../infra/http.js';
import { Logger } from '../../infra/logger.js';
import { normalizeDesktopState, normalizeUseStatusText } from '../../ctyun/client.js';

export interface WatchdogOptions {
  profileManager: ProfileManager;
  logger: Logger;
  baseIntervalMs?: number; // 基础间隔默认 5 分钟 (300,000ms)
  maxIntervalMs?: number;  // 最大退避间隔默认 15 分钟 (900,000ms)
}

export interface WatchdogState {
  active: boolean;
  consecutiveBusyCount: number; // 连续官方繁忙探测次数
  currentIntervalMs: number;
  nextProbeTime: number; // 下次探测的时间戳 (毫秒)
  timer?: NodeJS.Timeout;
}

/**
 * 桌面休眠/关机与避让看门狗服务 (Watchdog Service)
 *
 * 避让原则（依据官方协议语义）：
 * 1. 被服务端 119/4001 让位后，探针按 5m -> 10m -> 15m 指数退避 (含 ±30s Jitter) 巡检；
 * 2. 云电脑处于 ACTIVE/过渡态时，官方客户端可能仍在线 —— 绝不主动连接，
 *    否则同账号异设备接入会触发服务端 exitDesktop 广播将真机用户强制下线；
 * 3. 仅当云电脑归一化状态为 SUSPENED/SHUTOFF（用户已离开，实例已休眠或关机）时，
 *    才唤醒实例并重新接管保活长连。
 */
export class WatchdogService {
  private profileManager: ProfileManager;
  private logger: Logger;
  private baseIntervalMs: number;
  private maxIntervalMs: number;
  private states: Map<string, WatchdogState> = new Map();

  constructor(options: WatchdogOptions) {
    this.profileManager = options.profileManager;
    this.logger = options.logger;
    this.baseIntervalMs = options.baseIntervalMs || 5 * 60 * 1000;
    this.maxIntervalMs = options.maxIntervalMs || 15 * 60 * 1000;
  }

  /**
   * 启动单台桌面的自愈看门狗探针
   */
  public startWatchdog(accountName: string, desktopId: string): void {
    const key = `${accountName}:${desktopId}`;
    if (this.states.has(key)) return;

    const matched = this.profileManager.findDesktopByCode(desktopId);
    const dName = matched?.desktop?.desktopName || desktopId;
    this.logger.addLog('info', `[${accountName} - ${dName}] 官方客户端在线，后台长连接暂停让位 (启动自愈看门狗探针)`);

    const state: WatchdogState = {
      active: true,
      consecutiveBusyCount: 0,
      currentIntervalMs: this.baseIntervalMs,
      nextProbeTime: Date.now() + this.baseIntervalMs,
    };

    this.scheduleNextProbe(accountName, desktopId, state);
    this.states.set(key, state);
    this.profileManager.notifyStatusChange();
  }

  /**
   * 计算带退避和抖动的调度延迟
   */
  private scheduleNextProbe(accountName: string, desktopId: string, state: WatchdogState): void {
    // 退避因子：0 -> 5m, 1 -> 10m, >=2 -> 15m
    const multiplier = Math.min(Math.pow(2, state.consecutiveBusyCount), this.maxIntervalMs / this.baseIntervalMs);
    const calculatedInterval = Math.min(this.baseIntervalMs * multiplier, this.maxIntervalMs);
    // 注入 ±30s 随机 Jitter，防止多台设备固定周期撞击官方 API
    const jitter = Math.floor(Math.random() * 60000) - 30000;
    const finalInterval = Math.max(60000, calculatedInterval + jitter);

    state.currentIntervalMs = finalInterval;
    state.nextProbeTime = Date.now() + finalInterval;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      this.probeAndHeal(accountName, desktopId).catch((err) => {
        const matched = this.profileManager.findDesktopByCode(desktopId);
        const dName = matched?.desktop?.desktopName || desktopId;
        this.logger.addLog('warn', `[${accountName} - ${dName}] 探针巡检异常: ${errorText(err)}`);
        // 异常后继续调度下一次
        if (this.states.has(`${accountName}:${desktopId}`)) {
          this.scheduleNextProbe(accountName, desktopId, state);
        }
      });
    }, finalInterval);
  }

  /**
   * 停止指定账号下所有桌面的看门狗探针
   */
  public stopWatchdogsForAccount(accountName: string): void {
    for (const [key, state] of this.states.entries()) {
      if (key.startsWith(`${accountName}:`)) {
        if (state.timer) clearTimeout(state.timer);
        this.states.delete(key);
      }
    }
    this.profileManager.notifyStatusChange();
  }

  /**
   * 停止单台桌面的看门狗探针
   */
  public stopWatchdog(accountName: string, desktopId: string): void {
    const key = `${accountName}:${desktopId}`;
    const state = this.states.get(key);
    if (state) {
      if (state.timer) clearTimeout(state.timer);
      this.states.delete(key);
      this.profileManager.notifyStatusChange();
    }
  }

  /**
   * 获取指定桌面的看门狗运行态指标 (供 Profile 摘要与前端展示)
   */
  public getWatchdogInfo(accountName: string, desktopId: string) {
    const state = this.states.get(`${accountName}:${desktopId}`);
    if (!state || !state.active) return null;

    const remainingMs = Math.max(0, state.nextProbeTime - Date.now());
    return {
      active: true,
      currentIntervalSec: Math.round(state.currentIntervalMs / 1000),
      nextProbeSec: Math.round(remainingMs / 1000),
      failRounds: state.consecutiveBusyCount,
    };
  }

  /**
   * 获取所有活跃看门狗数量
   */
  public getActiveWatchdogCount(): number {
    return this.states.size;
  }

  /**
   * 清理全部看门狗探针
   */
  public stopAll(): void {
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.states.clear();
  }

  /**
   * 执行一次探针巡检与自愈决策
   */
  public async probeAndHeal(accountName: string, desktopId: string): Promise<void> {
    const client = this.profileManager.getClient(accountName);
    if (!client) {
      this.stopWatchdog(accountName, desktopId);
      return;
    }

    const key = `${accountName}:${desktopId}`;
    const state = this.states.get(key);
    if (!state) return;

    const matched = this.profileManager.findDesktopByCode(desktopId);
    const dName = matched?.desktop?.desktopName || desktopId;
    const desktopCode = matched?.desktop?.desktopCode || desktopId;
    const objType = matched?.desktop?.objType ?? 0;

    try {
      const stateInfo = await client.getDesktopState(desktopId, objType);
      const desktopState = stateInfo?.desktopState || '';
      const useStatusText = stateInfo?.useStatusText || '';

      // 官方协议语义: desktopState=ACTIVE 表示实例处于运行态，官方客户端可能仍在占用。
      // useStatus 无"活跃会话"含义 (官方仅用于救援模式 87/88)，不得据此判断客户端是否在线。
      // 运行态下主动接入会触发服务端 exitDesktop 广播踢掉真机用户，因此仅对已休眠/关机实例接管。
      const stateKind = normalizeDesktopState(desktopState);
      const textKind = normalizeUseStatusText(useStatusText);
      const isStoppedOrSleeping = stateKind === 'stopped' || stateKind === 'suspended' || textKind === 'stopped' || textKind === 'suspended';

      if (!isStoppedOrSleeping) {
        state.consecutiveBusyCount += 1;
        const nextMin = Math.round(
          Math.min(this.baseIntervalMs * Math.pow(2, state.consecutiveBusyCount), this.maxIntervalMs) / 60000,
        );
        this.logger.addLog(
          'info',
          `[${accountName} - ${dName}] 探针巡检: 云电脑处于运行态 (${useStatusText || desktopState || '运行中'})，可能仍有客户端在线，暂不连接 (第 ${state.consecutiveBusyCount} 次，下次约 ${nextMin} 分钟后)`,
        );
        this.scheduleNextProbe(accountName, desktopId, state);
        this.profileManager.notifyStatusChange();
        return;
      }

      // 实例已休眠/关机，用户已离开：满足自愈接管条件
      this.logger.addLog('info', `[${accountName} - ${dName}] 探针巡检: 云电脑已休眠/关机，启动自动接管自愈链路`);
      this.stopWatchdog(accountName, desktopId);

      try {
        await this.profileManager.operateDesktop(accountName, desktopCode, 'awake');
        this.logger.addLog('info', `[${accountName} - ${dName}] 已下发自愈唤醒指令`);
      } catch (startErr) {
        this.logger.addLog('warn', `[${accountName} - ${dName}] 自愈唤醒失败: ${errorText(startErr)}`);
      }

      // 精准接续恢复该桌面的保活长连接
      this.profileManager.getKeepaliveService().resumeWorkerForDesktop(accountName, desktopCode);
    } catch (err) {
      this.logger.addLog('warn', `[${accountName} - ${dName}] 探针检测失败: ${errorText(err)}`);
      // 网络或临时异常仍继续安排下一次
      if (this.states.has(key)) {
        this.scheduleNextProbe(accountName, desktopId, state);
      }
    }
  }
}
