const WEB_RELEASE_DEFAULT_DELAY_SEC = 20;
const WEB_ACTIVE_MAX_HOLD_SEC = 300; // 浏览器异常关闭兜底：最多让位 5 分钟

export class WebActiveTracker {
  private webReleaseTimers = new Map<string, NodeJS.Timeout>();
  private webActiveKeys = new Set<string>();
  private maxHoldTimers = new Map<string, NodeJS.Timeout>();
  private activeExpiresAt = new Map<string, number>();

  /**
   * 查询指定桌面当前是否处于前台 Web 活跃状态 (供保活同步时跳过，避免顶掉前台用户)
   */
  public isWebActive(canonicalKey: string): boolean {
    return this.webActiveKeys.has(canonicalKey);
  }

  /**
   * 获取指定桌面 Web 活跃的剩余秒数
   */
  public getRemainingActiveSec(canonicalKey: string): number {
    if (!this.webActiveKeys.has(canonicalKey)) return 0;
    const expiresAt = this.activeExpiresAt.get(canonicalKey);
    if (!expiresAt) return 0;
    return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  }

  private clearMaxHold(canonicalKey: string): void {
    const timer = this.maxHoldTimers.get(canonicalKey);
    if (timer) {
      clearTimeout(timer);
      this.maxHoldTimers.delete(canonicalKey);
    }
    this.activeExpiresAt.delete(canonicalKey);
  }

  private clearRelease(canonicalKey: string): void {
    const timer = this.webReleaseTimers.get(canonicalKey);
    if (timer) {
      clearTimeout(timer);
      this.webReleaseTimers.delete(canonicalKey);
    }
  }

  /**
   * 标记云电脑前台 Web 直连用户处于活跃状态
   * 1. 立即取消该桌面待执行的延迟释放任务；
   * 2. 首次进入活跃态时执行避让回调（如暂停保活 Worker、停止看门狗探针）；
   * 3. 启动最长让位兜底定时器（默认 5 分钟），防止浏览器崩溃未发 web-close 时后台永不恢复。
   */
  public touchWebActive(
    canonicalKey: string,
    onActive: () => void,
    maxHoldSec: number = WEB_ACTIVE_MAX_HOLD_SEC,
    onExpire?: () => void,
  ): void {
    if (!canonicalKey) return;

    this.clearRelease(canonicalKey);
    this.clearMaxHold(canonicalKey);

    if (!this.webActiveKeys.has(canonicalKey)) {
      this.webActiveKeys.add(canonicalKey);
      try {
        onActive();
      } catch {}
    }

    const holdMs = Math.max(60, Number(maxHoldSec) || WEB_ACTIVE_MAX_HOLD_SEC) * 1000;
    this.activeExpiresAt.set(canonicalKey, Date.now() + holdMs);
    const timer = setTimeout(() => {
      this.maxHoldTimers.delete(canonicalKey);
      this.activeExpiresAt.delete(canonicalKey);
      if (this.webReleaseTimers.has(canonicalKey)) return;
      this.webActiveKeys.delete(canonicalKey);
      try {
        onExpire?.();
      } catch {}
    }, holdMs);
    this.maxHoldTimers.set(canonicalKey, timer);
  }

  /**
   * 标记云电脑前台 Web 直连视窗关闭
   * 引入延迟释放宽限期（默认 20 秒），防止用户刷新浏览器瞬时断开后导致保活抢占冲突
   */
  public releaseWebActive(
    canonicalKey: string,
    delaySec: number = WEB_RELEASE_DEFAULT_DELAY_SEC,
    onResume: () => Promise<void> | void,
  ): void {
    if (!canonicalKey) return;

    this.clearRelease(canonicalKey);
    this.clearMaxHold(canonicalKey);
    this.activeExpiresAt.set(canonicalKey, Date.now() + Math.max(1, delaySec) * 1000);

    const timer = setTimeout(async () => {
      this.webReleaseTimers.delete(canonicalKey);
      this.activeExpiresAt.delete(canonicalKey);
      this.webActiveKeys.delete(canonicalKey);
      try {
        await onResume();
      } catch {}
    }, Math.max(1, delaySec) * 1000);

    this.webReleaseTimers.set(canonicalKey, timer);
  }

  public clearAll(): void {
    for (const timer of this.webReleaseTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.maxHoldTimers.values()) {
      clearTimeout(timer);
    }
    this.webReleaseTimers.clear();
    this.maxHoldTimers.clear();
    this.activeExpiresAt.clear();
    this.webActiveKeys.clear();
  }
}
