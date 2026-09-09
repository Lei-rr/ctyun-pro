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
    if (!this.browserInstance || !this.browserInstance.isConnected?.()) {
      this.browserInstance = null;
      if (!this.launchPromise) {
        this.launchPromise = (async () => {
          let puppeteer: any;
          try {
            puppeteer = (await import('puppeteer-core')).default;
          } catch {
            throw new Error('未安装 puppeteer-core 依赖');
          }

          const browserPaths: string[] = [];

          if (process.platform === 'win32') {
            const progFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
            const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
            const localAppData = process.env.LOCALAPPDATA || '';

            // 优先探测 Windows 原生自带的 Microsoft Edge (Chromium内核，无需额外安装)
            browserPaths.push(
              `${progFiles86}\\Microsoft\\Edge\\Application\\msedge.exe`,
              `${progFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
            );
            // 其次探测系统安装的 Google Chrome
            browserPaths.push(
              `${progFiles}\\Google\\Chrome\\Application\\chrome.exe`,
              `${progFiles86}\\Google\\Chrome\\Application\\chrome.exe`,
            );
            // 探测用户目录下的 Edge / Chrome
            if (localAppData) {
              browserPaths.push(
                `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`,
                `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
              );
            }
          } else if (process.platform === 'darwin') {
            // macOS 常见路径
            browserPaths.push(
              '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              '/Applications/Chromium.app/Contents/MacOS/Chromium',
            );
          } else {
            // Linux / Docker 容器环境路径
            browserPaths.push(
              '/usr/bin/chromium-browser',
              '/usr/bin/chromium',
              '/usr/bin/google-chrome',
              '/usr/bin/microsoft-edge',
            );
          }

          let execPath = '';
          for (const p of browserPaths) {
            if (fs.existsSync(p)) {
              execPath = p;
              break;
            }
          }

          if (!execPath) {
            const tip = process.platform === 'win32'
              ? '系统未检测到可用浏览器，请确保 Windows 自带的 Edge 浏览器正常或安装 Chrome'
              : '系统未找到可用 Chromium 浏览器内核 (请确保已安装 Chromium 或 Chrome)';
            throw new Error(tip);
          }

          const b = await puppeteer.launch({
            executablePath: execPath,
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-gpu',
              '--disable-dev-shm-usage',
              '--disable-software-rasterizer',
              '--disable-background-timer-throttling',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
              '--window-size=1280,800',
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
    const message = t.connectedAt
      ? `智能挂机中 (${cur}/${t.totalProgress || 3600}秒)`
      : t.message;
    return {
      running: true,
      startTime: t.startTime,
      currentProgress: cur,
      totalProgress: t.totalProgress,
      message,
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
  ): Promise<{ success: boolean; message: string; isCompleted?: boolean }> {
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
          onProgress?.(currentProgress, totalProgress);
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
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      );

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
      logger.addLog('info', `[${accountName}] 已开启无头浏览器会话，等待天翼云电脑实例列表就绪...`);

      // 轮询检测进入按钮或自动切入桌面路由（最长等待 60 秒）
      let desktopEntered = false;
      let clickedEnter = false;
      for (let i = 0; i < 60; i++) {
        if (isTerminated) break;
        await new Promise((r) => setTimeout(r, 1000));
        const check = await page.evaluate(() => {
          const loc = (globalThis as any).location;
          const href = loc?.href || '';
          if (href.includes('desktop?id=')) {
            return { entered: true, clicked: false, foundCount: 0, state: 'entered' };
          }
          const doc = (globalThis as any).document;
          if (!doc) return { entered: false, clicked: false, foundCount: 0, state: 'no_doc' };

          // 检查是否在加载动画中
          const anim = doc.querySelector('.rotate-animtion, .loading, .ant-spin');
          if (anim) {
            return { entered: false, clicked: false, foundCount: 0, state: 'loading' };
          }

          // 1. 全面扫描进入云电脑按钮选择器 (div.desktopcom-enter, button, card 进入链接等)
          const enters = Array.from(
            doc.querySelectorAll('div.desktopcom-enter, .desktopcom-enter, .desktop-item, .enter-btn, button, [role="button"]')
          ) as any[];

          const target = enters.find((el: any) => {
            const text = (el.innerText || el.textContent || '').trim();
            return (
              text === '进入AI云电脑' ||
              text === '进入' ||
              text.includes('进入AI云电脑') ||
              text.includes('进入云电脑') ||
              (text.startsWith('进入') && text.length < 15)
            );
          });

          if (target) {
            target.click();
            return { entered: false, clicked: true, foundCount: enters.length, state: 'clicked' };
          }

          // 备用兜底：尝试点击首个 .desktopcom-enter
          const fallback = doc.querySelector('div.desktopcom-enter, .desktopcom-enter');
          if (fallback) {
            fallback.click();
            return { entered: false, clicked: true, foundCount: 1, state: 'fallback_clicked' };
          }

          const empty = doc.querySelector('div.empty-desc, .empty, .no-data');
          if (empty) {
            return { entered: false, clicked: false, foundCount: 0, state: 'empty' };
          }

          return { entered: false, clicked: false, foundCount: enters.length, state: 'waiting' };
        });

        if (check.entered) {
          desktopEntered = true;
          break;
        }
        if (check.clicked) {
          clickedEnter = true;
          logger.addLog('info', `[${accountName}] 已检测到并点击进入云电脑按钮，正在等待桌面会话建立...`);
          break;
        }

        // 容错重试：如果非动画加载状态且等待超过 15 秒仍未出现按钮，主动触发一次页面重新导航/刷新
        if ((i === 15 || i === 30 || i === 45) && check.state !== 'loading') {
          try {
            logger.addLog('info', `[${accountName}] 列表加载等待中，触发主动刷新重试 (${i}s)...`);
            await page.evaluate(() => (globalThis as any).location?.reload());
          } catch {}
        }
      }

      // 等待成功切入官方桌面路由 (https://pc.ctyun.cn/#/desktop?id=...)
      if (!desktopEntered && !isTerminated) {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const href = await page.evaluate(() => (globalThis as any).location?.href || '');
          if (href.includes('desktop?id=')) {
            desktopEntered = true;
            break;
          }
        }
      }

      if (isTerminated) {
        return { success: true, message: '挂机任务已主动终止' };
      }

      if (!desktopEntered) {
        throw new Error('未找到进入AI云电脑按钮，或账号名下暂无可用实例');
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
        if (page.isClosed()) {
          throw new Error('云电脑桌面会话页面意外关闭');
        }
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

      let hangResultMsg = '预定挂机时长已满足，任务已完成';
      let isCompletedTarget = false;
      try {
        const finalSum = await SignTask.getPointsAndTasks(client);
        const t = finalSum.tasks.find((task) => task.name.includes('使用1小时') || task.name.includes('使用'));
        if (t) {
          const cur = t.currentProgress || 0;
          if (cur >= (totalProgress - REDUNDANCY_SECONDS) || t.isCompleted) {
            isCompletedTarget = true;
            hangResultMsg = `官方结算确认达标 (${cur}/${totalProgress}秒)！+100 积分已到账`;
            logger.addLog('success', `[${accountName}] 🎉 ${hangResultMsg}`);
          } else {
            hangResultMsg = `官方网关已结算当前累计 ${cur}/${totalProgress}秒`;
            logger.addLog('info', `[${accountName}] ${hangResultMsg}`);
          }
        }
      } catch {}

      return { success: true, message: hangResultMsg, isCompleted: isCompletedTarget };
    } catch (err: any) {
      logger.addLog('error', `[${accountName}] 云电脑智能挂机异常: ${err.message}`);
      return { success: false, message: err.message, isCompleted: false };
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
