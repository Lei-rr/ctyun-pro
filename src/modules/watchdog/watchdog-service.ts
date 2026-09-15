import { ProfileManager } from '../../core/profile-manager.js';
import { Logger } from '../../core/logger.js';

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
 * 职责：
 * 1. 管理受控桌面避让自愈探针生命周期（支持 5m -> 10m -> 15m 指数退避与 ±30s 随机 Jitter 防风控）；
 * 2. 探针精准调用 client.getDesktopState 读取 useStatus 与 desktopState；
 * 3. 当 useStatus === '20' (无活跃会话) 或脱离运行态 (关机/休眠) 时，自动唤醒开机并拉起保活长连接。
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
        this.logger.addLog('warn', `[${accountName} - ${dName}] 探针巡检异常: ${err instanceof Error ? err.message : String(err)}`);
        // 异常后继续调度下一次
        if (this.states.has(`${accountName}:${desktopId}`)) {
          this.scheduleNextProbe(accountName, desktopId, state);
        }
      });
    }, finalInterval);
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
   * 检查探针是否激活
   */
  public hasWatchdog(accountName: string, desktopId: string): boolean {
    return this.states.has(`${accountName}:${desktopId}`);
  }

  /**
   * 获取单台桌面的看门狗状态详情 (供前端与 API 展示倒计时与轮询信息)
   */
  public getWatchdogStatus(accountName: string, desktopId: string) {
    const state = this.states.get(`${accountName}:${desktopId}`);
    if (!state) return null;
    const remainingMs = Math.max(0, state.nextProbeTime - Date.now());
    return {
      active: true,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      currentIntervalSeconds: Math.round(state.currentIntervalMs / 1000),
      busyCount: state.consecutiveBusyCount,
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
      const useStatus = stateInfo?.useStatus;
      const desktopState = stateInfo?.desktopState || '';
      const useStatusText = stateInfo?.useStatusText || '';

      // 判断官方客户端是否仍处于活跃占用中
      // useStatus: '25' = 使用中/有活跃会话；'20' = 空闲/无活跃会话
      const isStillBusy = useStatus === '25' || (useStatusText.includes('使用') && !useStatusText.includes('未'));

      if (isStillBusy) {
        state.consecutiveBusyCount += 1;
        const nextMin = Math.round(Math.min(this.baseIntervalMs * Math.pow(2, state.consecutiveBusyCount), this.maxIntervalMs) / 60000);
        this.logger.addLog('info', `[${accountName} - ${dName}] 探针巡检: 官方客户端仍在活跃使用中 (第 ${state.consecutiveBusyCount} 次，下次退避探测约 ${nextMin} 分钟后)`);
        this.scheduleNextProbe(accountName, desktopId, state);
        this.profileManager.notifyStatusChange();
        return;
      }

      // 官方客户端已退出或云电脑已关机/休眠：满足自愈接管条件
      this.logger.addLog('info', `[${accountName} - ${dName}] 探针巡检: 官方客户端已退出，启动自动接管自愈链路`);
      this.stopWatchdog(accountName, desktopId);

      // 若处于关机或休眠状态，自动下发唤醒开机指令
      const isStoppedOrSleeping = 
        desktopState === 'SHUTOFF' || 
        desktopState === 'SUSPENDED' || 
        useStatusText.includes('关机') || 
        useStatusText.includes('休眠') || 
        useStatusText.includes('睡眠');

      if (isStoppedOrSleeping) {
        try {
          await this.profileManager.operateDesktop(accountName, desktopCode, 'awake');
          this.logger.addLog('info', `[${accountName} - ${dName}] 已下发自愈唤醒指令`);
        } catch (startErr) {
          this.logger.addLog('warn', `[${accountName} - ${dName}] 自愈唤醒失败: ${startErr instanceof Error ? startErr.message : String(startErr)}`);
        }
      }

      // 精准接续恢复该桌面的保活长连接
      this.profileManager.getKeepaliveService().resumeWorkerForDesktop(accountName, desktopCode);
    } catch (err) {
      this.logger.addLog('warn', `[${accountName} - ${dName}] 探针检测失败: ${err instanceof Error ? err.message : String(err)}`);
      // 网络或临时异常仍继续安排下一次
      if (this.states.has(key)) {
        this.scheduleNextProbe(accountName, desktopId, state);
      }
    }
  }
}
