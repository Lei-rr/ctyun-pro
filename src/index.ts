import { Config } from './config.js';
import { createServer } from './server.js';

async function main() {
  Config.initDirs();
  const server = await createServer();
  const port = Config.port;
  const host = Config.host;

  try {
    await server.listen({ port, host });
    console.log(`\n======================================================`);
    console.log(`🚀 天翼云电脑智能保活管理系统 (CtYun) 已就绪！`);
    console.log(`📡 服务地址: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
    console.log(`📁 数据目录: ${Config.dataDir}`);
    console.log(`✨ 免 OCR 人工直连 | 纯协议保活 | 现代化 Web 控制台`);
    console.log(`======================================================\n`);
  } catch (err: any) {
    console.error('启动服务失败:', err.message);
    process.exit(1);
  }

  // 优雅停机处理 (Graceful Shutdown)
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Process] 收到 ${signal} 信号，正在执行优雅停机...`);
    try {
      const manager = (server as any).manager;
      if (manager && typeof manager.stopAll === 'function') {
        console.log('[Process] 正在安全停止所有协议保活信道、挂机进程并保存状态...');
        await manager.stopAll();
      }
      await server.close();
      console.log('[Process] 优雅停机完毕，服务已安全退出。');
      process.exit(0);
    } catch (err: any) {
      console.error('[Process] 停机流程异常:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => {
  console.error('[Process] 未捕获异常 (已拦截保护):', err.message);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[Process] 未处理异步拒绝 (已拦截保护):', reason?.message || reason);
});

main();
