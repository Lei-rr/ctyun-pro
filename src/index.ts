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
}

process.on('uncaughtException', (err) => {
  console.error('[Process] 未捕获异常 (已拦截保护):', err.message);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[Process] 未处理异步拒绝 (已拦截保护):', reason?.message || reason);
});

main();
