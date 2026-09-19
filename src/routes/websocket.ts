import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { ProfileManager } from '../core/profile-manager.js';
import type { AuthContext } from './auth.js';

export function setupWebSocket(
  fastify: FastifyInstance,
  manager: ProfileManager,
  authContext: AuthContext,
) {
  const { isValidToken, parseCookieToken } = authContext;

  // 全双工实时 WebSocket (用于状态与日志统一推送，天然兼容 ws:// 与 wss://)
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    // 首次连入立即推送全量状态与近期日志
    try {
      ws.send(
        JSON.stringify({
          type: 'status',
          data: {
            needAuth: Boolean(manager.adminPassword),
            accounts: manager.getAccountsSummary(),
          },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'init_logs',
          logs: manager.getRecentLogs(),
        }),
      );
    } catch {}

    // 订阅后续状态变更与新日志
    const unSubStatus = manager.subscribeStatus(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(
            JSON.stringify({
              type: 'status',
              data: {
                needAuth: Boolean(manager.adminPassword),
                accounts: manager.getAccountsSummary(),
              },
            }),
          );
        } catch {}
      }
    });

    const unSubLogs = manager.subscribeLogs((log) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          if (log.message === '__CLEAR__') {
            ws.send(JSON.stringify({ type: 'init_logs', logs: [] }));
          } else {
            ws.send(JSON.stringify({ type: 'log', log }));
          }
        } catch {}
      }
    });

    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {}
      }
    }, 30000);

    ws.on('close', () => {
      clearInterval(pingTimer);
      unSubStatus();
      unSubLogs();
    });
    ws.on('error', () => {
      clearInterval(pingTimer);
      unSubStatus();
      unSubLogs();
    });
  });

  // 挂载到 Fastify 底层 HTTP Server 的 upgrade 事件
  fastify.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token') || parseCookieToken(request.headers.cookie);
      if (manager.adminPassword && (!token || !isValidToken(token))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  // 优雅停机钩子：Fastify 停机时安全关闭 WebSocket Server 实例
  fastify.addHook('onClose', async () => {
    wss.clients.forEach((client) => {
      try {
        client.terminate();
      } catch {}
    });
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  return wss;
}
