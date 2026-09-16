const WEB_RELEASE_DEFAULT_DELAY_SEC = 20;

export class WebActiveTracker {
  private webReleaseTimers = new Map<string, NodeJS.Timeout>();

  /**
   * 标记云电脑前台 Web 直连用户处于活跃状态
   * 立即取消该桌面待执行的延迟释放任务，并执行避让回调（如暂停保活 Worker、停止看门狗探针）
   */
  public touchWebActive(
    canonicalKey: string,
    onActive: () => void,
  ): void {
    if (!canonicalKey) return;

    if (this.webReleaseTimers.has(canonicalKey)) {
      clearTimeout(this.webReleaseTimers.get(canonicalKey)!);
      this.webReleaseTimers.delete(canonicalKey);
    }

    onActive();
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

    if (this.webReleaseTimers.has(canonicalKey)) {
      clearTimeout(this.webReleaseTimers.get(canonicalKey)!);
      this.webReleaseTimers.delete(canonicalKey);
    }

    const timer = setTimeout(async () => {
      this.webReleaseTimers.delete(canonicalKey);
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
    this.webReleaseTimers.clear();
  }
}
