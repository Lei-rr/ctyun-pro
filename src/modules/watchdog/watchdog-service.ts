import { ProfileManager } from '../../core/profile-manager.js';
import { Logger } from '../../core/logger.js';

export interface WatchdogOptions {
  profileManager: ProfileManager;
  logger: Logger;
  intervalMs?: number; // 默认 5 分钟 (300,000ms)
}

/**
 * 桌面休眠/关机与避让看门狗服务 (Watchdog Service)
 * 职责：
 * 1. 管理受控桌面 5 分钟探针生命周期；
 * 2. 探针精准调用 client.getDesktopState 读取 useStatus 与 desktopState；
 * 3. 当 useStatus === '20' (无活跃会话) 或脱离运行态 (关机/休眠) 时，自动唤醒开机并拉起保活长连接。
 */
export class WatchdogService {
  private profileManager: ProfileManager;
  private logger: Logger;
  private intervalMs: number;
  private timers: Map<string, NodeJS.Timeout> = new Map();

  constructor(options: WatchdogOptions) {
    this.profileManager = options.profileManager;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs || 5 * 60 * 1000;
  }

  /**
   * 启动单台桌面的 5 分钟自愈看门狗探针
   */
  public startWatchdog(accountName: string, desktopId: string): void {
    const key = `${accountName}:${desktopId}`;
    if (this.timers.has(key)) return;

    const matched = this.profileManager.findDesktopByCode(desktopId);
    const dName = matched?.desktop?.desktopName || desktopId;
    this.logger.addLog('info', `[${accountName} - ${dName}] 官方客户端在线，后台长连接暂停让位 (启动 5 分钟休眠看门狗探针)`);

    const timer = setInterval(() => {
      this.probeAndHeal(accountName, desktopId).catch((err) => {
        this.logger.addLog('warn', `[${accountName} - ${dName}] 探针巡检异常: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.intervalMs);

    this.timers.set(key, timer);
  }

  /**
   * 停止单台桌面的看门狗探针
   */
  public stopWatchdog(accountName: string, desktopId: string): void {
    const key = `${accountName}:${desktopId}`;
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  /**
   * 检查探针是否激活
   */
  public hasWatchdog(accountName: string, desktopId: string): boolean {
    return this.timers.has(`${accountName}:${desktopId}`);
  }

  /**
   * 清理全部看门狗探针
   */
  public clearAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /**
   * 执行单次探针自愈与恢复判定
   */
  private async probeAndHeal(accountName: string, desktopId: string): Promise<void> {
    const client = this.profileManager.getClient(accountName);
    if (!client.loginInfo) return;

    const matched = this.profileManager.findDesktopByCode(desktopId);
    const dName = matched?.desktop?.desktopName || desktopId;
    const desktopCode = matched?.desktop?.desktopCode || desktopId;
    const realDesktopId = matched?.desktop?.desktopId || desktopId;
    const objTypeNum = typeof matched?.desktop?.objType === 'number' ? matched.desktop.objType : 0;

    try {
      let stateResp: any = null;
      try {
        stateResp = await client.getDesktopState(realDesktopId, objTypeNum);
      } catch {
        // 若单机状态接口失败，回退至重新加载列表
        await this.profileManager.reloadDesktops(accountName);
      }

      const freshDesktop = this.profileManager.findDesktopByCode(desktopCode)?.desktop;
      const useStatus = stateResp?.useStatus ?? freshDesktop?.useStatus;
      const isPowerOff = stateResp
        ? String(stateResp.desktopState) === '2' || stateResp.osStatus === 0
        : (freshDesktop?.osStatus === 0);

      // useStatus === '20' 说明官方客户端已断开并释放；或者关机/休眠
      if (useStatus === '20' || isPowerOff) {
        this.logger.addLog('info', `[${accountName} - ${dName}] 探针检测到官方会话已释放 (useStatus: ${useStatus || '休眠'}), 准备自愈恢复保活`);

        // 停止看门狗
        this.stopWatchdog(accountName, desktopId);

        // 若处于关机/休眠，先执行唤醒开机
        if (isPowerOff) {
          try {
            await this.profileManager.operateDesktop(accountName, desktopCode, 'awake');
            this.logger.addLog('info', `[${accountName} - ${dName}] 已下发自愈唤醒指令`);
          } catch (startErr) {
            this.logger.addLog('warn', `[${accountName} - ${dName}] 自愈唤醒失败: ${startErr instanceof Error ? startErr.message : String(startErr)}`);
          }
        }

        // 精准接续恢复该桌面的保活长连接
        this.profileManager.getKeepaliveService().resumeWorkerForDesktop(accountName, desktopCode);
      }
    } catch (err) {
      this.logger.addLog('warn', `[${accountName} - ${dName}] 探针检测失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
