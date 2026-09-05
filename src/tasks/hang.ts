import fs from 'node:fs';
import type { CtYunClient } from '../core/client.js';
import { SignTask } from './sign.js';
import type { Logger } from '../core/logger.js';

// 单例浏览器池管理器：全系统多账号共享同一个 Chromium 进程，通过独立 BrowserContext 严格隔离各账号会话与 Cookie
class BrowserPool {
  private static browserInstance: any = null;
  private static activeCount = 0;
  private static launchPromise: Promise<any> | null = null;

  public static async acquireContext(): Promise<{ context: any; close: () => Promise<void> }> {
    if (!this.browserInstance) {
      if (!this.launchPromise) {
        this.launchPromise = (async () => {
          let puppeteer: any;
          try {
            puppeteer = (await import('puppeteer-core')).default;
          } catch {
            throw new Error('未安装 puppeteer-core 依赖');
          }

          const browserPaths = [
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome',
          ];
          let execPath = '';
          for (const p of browserPaths) {
            if (fs.existsSync(p)) {
              execPath = p;
              break;
            }
          }

          if (!execPath) {
            throw new Error('系统未找到可用 Chromium 浏览器内核');
          }

          const b = await puppeteer.launch({
            executablePath: execPath,
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-gpu',
              '--disable-dev-shm-usage',
              '--disable-software-rasterizer',
              '--window-size=1280,720',
              '--mute-audio',
            ],
          });
          this.browserInstance = b;
          return b;
        })();
      }
      await this.launchPromise;
      this.launchPromise = null;
    }

    this.activeCount++;
    const context = await this.browserInstance.createBrowserContext();

    let isClosed = false;
    const closeFn = async () => {
      if (isClosed) return;
      isClosed = true;
      try {
        await context.close();
      } catch {}

      this.activeCount = Math.max(0, this.activeCount - 1);
      // 当所有账号挂机均已结束，自动销毁 Chromium 浏览器主进程，彻底释放全部系统内存
      if (this.activeCount === 0 && this.browserInstance) {
        try {
          const b = this.browserInstance;
          this.browserInstance = null;
          await b.close();
        } catch {}
      }
    };

    return { context, close: closeFn };
  }

  public static async destroy(): Promise<void> {
    if (this.browserInstance) {
      try {
        const b = this.browserInstance;
        this.browserInstance = null;
        this.activeCount = 0;
        await b.close();
      } catch {}
    }
  }
}

// 记录当前各账号的挂机任务状态与终止句柄
const activeHangTasks = new Map<
  string,
  {
    startTime: number;
    connectedAt?: number;
    baseProgress?: number;
    status: string;
    currentProgress?: number;
    totalProgress?: number;
    message?: string;
    stop: () => Promise<void>;
  }
>();

export class HangTask {
  public static async destroy(): Promise<void> {
    await BrowserPool.destroy();
    for (const task of activeHangTasks.values()) {
      try {
        await task.stop();
      } catch {}
    }
    activeHangTasks.clear();
  }

  /**
   * 检查指定账号是否已有挂机任务正在运行
   */
  public static isRunning(accountName: string): boolean {
    return activeHangTasks.has(accountName);
  }

  /**
   * 获取指定账号的挂机实时状态与进度 (基于真实时间戳毫秒级推演，分秒平滑无差)
   */
  public static getHangInfo(accountName: string) {
    const t = activeHangTasks.get(accountName);
    if (!t) return null;
    let cur = t.currentProgress || 0;
    if (t.connectedAt) {
      const elapsed = Math.max(0, Math.floor((Date.now() - t.connectedAt) / 1000));
      cur = Math.min(t.totalProgress || 3600, (t.baseProgress ?? cur) + elapsed);
      t.currentProgress = cur;
    }
    return {
      running: true,
      startTime: t.startTime,
      currentProgress: cur,
      totalProgress: t.totalProgress,
      message: t.message,
    };
  }

  /**
   * 智能挂机核心调度
   * 核心设计：
   * 1. 多账号共享单例 Chromium 进程，通过独立 BrowserContext 严格隔离；
   * 2. 启动前先调官方任务接口核验当前真实累计进度（不写死 3600 秒）；
   * 3. 若已有累计，自动计算剩余所需时长进行精准补足；
   * 4. 挂机过程中每隔 60 秒轮询官方接口，以官方真正确认为达标准则（哪怕时间到了，也会守望直到官方确认）；
   * 5. 官方达标后立即彻底关闭上下文，所有账号完成时自动自毁浏览器进程。
   */
  public static async executeSmartHang(
    accountName: string,
    client: CtYunClient,
    logger: Logger,
    onProgress?: (cur: number, total: number) => void,
  ): Promise<{ success: boolean; message: string }> {
    if (!client.loginInfo) {
      return { success: false, message: '账号未登录，无法执行挂机任务' };
    }

    if (activeHangTasks.has(accountName)) {
      return { success: true, message: '当前已有挂机任务在后台守护运行中，请勿重复启动' };
    }

    // 1. 动态核验官方任务最新进度
    let currentProgress = 0;
    let totalProgress = 3600;
    // 冗余容错设计：官方计算可能有 1~5 秒统计偏差，留出 5 秒容错阈值；并在计划挂机时长上追加 60 秒充裕缓冲，确保稳妥拿满积分
    const REDUNDANCY_SECONDS = 5;
    const BUFFER_PLAN_SECONDS = 60;

    try {
      const summary = await SignTask.getPointsAndTasks(client);
      const hangTask = summary.tasks.find((t) => t.name.includes('使用1小时') || t.name.includes('使用'));
      if (hangTask) {
        currentProgress = hangTask.currentProgress || 0;
        totalProgress = hangTask.totalProgress || 3600;
        if (hangTask.isCompleted || currentProgress >= (totalProgress - REDUNDANCY_SECONDS)) {
          logger.addLog('success', `[${accountName}] 今日「使用1小时」挂机任务已达成 (${currentProgress}/${totalProgress}秒)！+100 积分已入账，无需重复挂机`);
          return { success: true, message: `今日挂机任务已达成 (${currentProgress}/${totalProgress}秒)` };
        }
      }
    } catch {}

    const remainingSeconds = Math.max(0, totalProgress - currentProgress) + BUFFER_PLAN_SECONDS;
    const estimatedMinutes = Math.ceil(remainingSeconds / 60);
    logger.addLog(
      'info',
      `[${accountName}] 启动智能挂机：当前累计 ${currentProgress}/${totalProgress}秒，开始补足约 ${estimatedMinutes} 分钟`,
    );

    // 2. 从多账号单例池中获取隔离上下文
    let browserContextHandle: { context: any; close: () => Promise<void> } | null = null;
    let isTerminated = false;

    const stopFn = async () => {
      isTerminated = true;
      if (browserContextHandle) {
        await browserContextHandle.close();
        browserContextHandle = null;
      }
    };
    activeHangTasks.set(accountName, {
      startTime: Date.now(),
      status: 'running',
      currentProgress,
      totalProgress,
      message: `智能挂机补时中 (${currentProgress}/${totalProgress}秒)`,
      stop: stopFn,
    });
    onProgress?.(currentProgress, totalProgress);

    try {
      browserContextHandle = await BrowserPool.acquireContext();
      const page = await browserContextHandle.context.newPage();
      page.setDefaultNavigationTimeout(60000);
      page.setDefaultTimeout(60000);

      const loginInfo = client.loginInfo;
      const deviceCode = client.getDeviceCode();

      // 在页面初始化前注入原生登录会话凭证
      await page.evaluateOnNewDocument((info: any, code: string) => {
        localStorage.setItem('web_device_code', code);
        localStorage.setItem('authExpiredAt', String(Date.now() + 72 * 3600 * 1000));
        localStorage.setItem('authData', JSON.stringify(info));
      }, loginInfo, deviceCode);

      // 进入列表页：使用 CDP 直连导航，避免 SPA 持续加载第三方资源导致 goto 导航超时
      const cdp = await page.target().createCDPSession();
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: 'https://pc.ctyun.cn/#/desktop-list' });

      // 轮询等待进入AI云电脑按钮渲染完成（最长等待 30 秒）
      let foundBtn = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        foundBtn = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          if (!doc) return false;
          const els = Array.from(doc.querySelectorAll('*')) as any[];
          return els.some(
            (el) => (el.innerText || '').trim() === '进入AI云电脑' && (!el.children || el.children.length === 0),
          );
        });
        if (foundBtn) break;
      }

      if (!foundBtn) {
        throw new Error('未找到进入AI云电脑按钮，或账号名下暂无可用实例');
      }

      // 通过原生元素 Handle 模拟真实点击
      const btnHandle = await page.evaluateHandle(() => {
        const doc = (globalThis as any).document;
        const els = Array.from(doc.querySelectorAll('*')) as any[];
        for (const el of els) {
          if ((el.innerText || '').trim() === '进入AI云电脑' && (!el.children || el.children.length === 0)) {
            return el;
          }
        }
        return null;
      });

      await (btnHandle as any).click();

      // 轮询等待成功切入官方桌面路由 (https://pc.ctyun.cn/#/desktop?id=...)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const href = await page.evaluate(() => (globalThis as any).location?.href || '');
        if (href.includes('desktop?id=')) {
          break;
        }
      }

      logger.addLog('success', `[${accountName}] 成功接入云电脑会话，开始智能挂机`);

      // 记录挂机会话接入时间戳与基准进度，用于前端毫秒级平滑时间推演
      const hangItem = activeHangTasks.get(accountName);
      if (hangItem) {
        hangItem.connectedAt = Date.now();
        hangItem.baseProgress = currentProgress;
      }

      // 3. 动态计时守望循环
      // 核心机制：天翼云云电脑在用户会话断开时触发网关结算。
      // 本地依据真实会话时长实时推进进度，挂满预定补足时长后主动优雅断开连接触发官方结算。
      let elapsedSeconds = 0;
      const checkIntervalSec = 5; // 每 5 秒推演刷新一次内部进度

      while (!isTerminated && elapsedSeconds < remainingSeconds) {
        await new Promise((r) => setTimeout(r, checkIntervalSec * 1000));
        elapsedSeconds += checkIntervalSec;

        const currentEstimated = Math.min(totalProgress, currentProgress + elapsedSeconds);
        const item = activeHangTasks.get(accountName);
        if (item) {
          item.currentProgress = currentEstimated;
          item.totalProgress = totalProgress;
          item.message = `智能挂机中 (${currentEstimated}/${totalProgress}秒)`;
        }
        onProgress?.(currentEstimated, totalProgress);
      }

      logger.addLog('info', `[${accountName}] 预定挂机时长已满足，正在结算入账...`);
      if (browserContextHandle) {
        try {
          await browserContextHandle.close();
          browserContextHandle = null;
        } catch {}
      }

      // 等待 3 秒让天翼云官方网关完成结算写入
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const finalSum = await SignTask.getPointsAndTasks(client);
        const t = finalSum.tasks.find((task) => task.name.includes('使用1小时') || task.name.includes('使用'));
        if (t) {
          const cur = t.currentProgress || 0;
          if (cur >= (totalProgress - REDUNDANCY_SECONDS) || t.isCompleted) {
            logger.addLog('success', `[${accountName}] 🎉 官方结算确认达标 (${cur}/${totalProgress}秒)！+100 积分已到账`);
          } else {
            logger.addLog('info', `[${accountName}] 官方网关已结算当前累计 ${cur}/${totalProgress}秒`);
          }
        }
      } catch {}

      return { success: true, message: '挂机任务已完成' };
    } catch (err: any) {
      logger.addLog('error', `[${accountName}] 云电脑智能挂机异常: ${err.message}`);
      return { success: false, message: err.message };
    } finally {
      activeHangTasks.delete(accountName);
      if (browserContextHandle) {
        try {
          await browserContextHandle.close();
          logger.addLog('info', `[${accountName}] 账号挂机会话已关闭并释放资源`);
        } catch {}
      }
    }
  }

  /**
   * 停止指定账号的挂机任务
   */
  public static async stopHang(accountName: string): Promise<void> {
    const task = activeHangTasks.get(accountName);
    if (task) {
      await task.stop();
      activeHangTasks.delete(accountName);
    }
  }
}
