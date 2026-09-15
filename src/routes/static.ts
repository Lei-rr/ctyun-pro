import path from 'node:path';
import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { EMBEDDED_WEB_FILES } from '../embedded-web.js';

export const staticRoutes: FastifyPluginAsync = async (fastify) => {
  // 优先读取外部 web/dist，若无则自动使用二进制内嵌的前端资源
  const webDist = path.resolve(process.cwd(), 'web/dist');
  const hasLocalDist = fs.existsSync(webDist);

  if (hasLocalDist) {
    await fastify.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    });
    fastify.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        reply.code(404).send({ success: false, msg: 'API 接口不存在' });
      } else {
        reply.sendFile('index.html');
      }
    });
  } else if (Object.keys(EMBEDDED_WEB_FILES).length > 0) {
    // 独立二进制模式：从内存中响应内嵌的前端资源
    fastify.setNotFoundHandler((req, reply) => {
      let reqPath = req.url.split('?')[0].replace(/^\/+/, '');
      if (reqPath === '' || reqPath === 'index.html') {
        reqPath = 'index.html';
      }

      const file = EMBEDDED_WEB_FILES[reqPath];
      if (file) {
        reply.header('Content-Type', file.contentType);
        if (file.encoding === 'base64') {
          return reply.send(Buffer.from(file.content, 'base64'));
        }
        return reply.send(file.content);
      }

      // 非 API 路径统一 fallback 到 index.html (SPA 客户端路由)
      if (!req.url.startsWith('/api')) {
        const indexFile = EMBEDDED_WEB_FILES['index.html'];
        if (indexFile) {
          reply.header('Content-Type', indexFile.contentType);
          return reply.send(indexFile.content);
        }
      }

      return reply.code(404).send({ success: false, msg: '资源不存在' });
    });
  }
};
