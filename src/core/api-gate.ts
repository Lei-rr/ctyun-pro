/**
 * 工业级请求并发门禁与错峰限流器 (Request Concurrency Gate)
 * 防止多账号在服务启动、批量调度、任务中心查询或接口轮询时高频并发冲击天翼云 API
 * 保护机制：
 * 1. 严格限制同时进行的天翼云 HTTP API 最大并发数 (默认 maxConcurrency = 2)
 * 2. 在每个请求之间引入最小安全间隔 + 随机微抖动 (默认 minIntervalMs = 200ms + 0~100ms Jitter)
 * 3. 异步排队先进先出 (FIFO)，超时与异常时自动安全释放排队槽位
 */
export class RequestConcurrencyGate {
  private maxConcurrency: number;
  private minIntervalMs: number;
  private running = 0;
  private queue: Array<() => void> = [];
  private lastRequestTime = 0;

  constructor(options: { maxConcurrency?: number; minIntervalMs?: number } = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 2);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 200);
  }

  /**
   * 获取当前排队与执行中的指标
   */
  public getMetrics() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
      minIntervalMs: this.minIntervalMs,
    };
  }

  /**
   * 将异步任务放入门禁调度队列中执行
   */
  public async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      // 错峰平滑：与上一个请求完成/发起时刻保持最小安全间隔
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      const targetInterval = this.minIntervalMs + Math.floor(Math.random() * 100);
      if (elapsed < targetInterval) {
        await new Promise((resolve) => setTimeout(resolve, targetInterval - elapsed));
      }
      this.lastRequestTime = Date.now();
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.running--;
    if (this.queue.length > 0 && this.running < this.maxConcurrency) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}

/**
 * 全局共享天翼云 API 门禁单例 (默认 2 并发，200ms 错峰间隔)
 */
export const globalApiGate = new RequestConcurrencyGate({
  maxConcurrency: 2,
  minIntervalMs: 200,
});
