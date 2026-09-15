import dns from 'dns';
import { Config } from './config.js';
import { createServer } from './server.js';

// 强制 IPv4 优先解析，彻底规避双栈/无 IPv6 路由导致的连接挂起与超时
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

async function main() {
  Config.initDirs();
  const server = await createServer();
  const port = Config.port;
  const host = Config.host;

  try {
    await server.listen({ port, host });
    console.log(`\n======================================================`);
    console.log(`天翼云电脑智能保活管理系统 (CtYun) 已就绪！`);
    console.log(`服务地址: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
    console.log(`数据目录: ${Config.dataDir}`);
    const manager = server.manager;
    if (manager && !manager.adminPassword) {
      console.log(`[安全提示] 当前为免密访问模式，建议尽快在 Web 控制台「系统设置」中设置管理密码以保障安全。`);
    }
    console.log(`免 OCR 人工直连 | 纯协议保活 | 现代化 Web 控制台`);
    console.log(`======================================================\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('启动服务失败:', msg);
    process.exit(1);
  }

  // 优雅停机处理 (Graceful Shutdown)
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Process] 收到 ${signal} 信号，正在执行优雅停机...`);

    // 设定 10 秒硬超时，防止异步 hang 住导致容器/进程僵死
    const forceExitTimer = setTimeout(() => {
      console.error('[Process] 停机流程超时 (10s)，强制退出。');
      process.exit(1);
    }, 10000);
    if (forceExitTimer.unref) forceExitTimer.unref();

    try {
      const manager = server.manager;
      if (manager && typeof manager.stopAll === 'function') {
        console.log('[Process] 正在安全停止所有协议保活信道、挂机进程并保存状态...');
        await manager.stopAll();
      }
      await server.close();
      clearTimeout(forceExitTimer);
      console.log('[Process] 优雅停机完毕，服务已安全退出。');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Process] 停机流程异常:', msg);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[Process] 未捕获异常 (已拦截保护):', msg);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[Process] 未处理异步拒绝 (已拦截保护):', msg);
});

main();
