import type { FastifyReply } from 'fastify';

/**
 * 统一标准 API 成功响应
 */
export function sendSuccess<T = unknown>(reply: FastifyReply, data?: T, msg?: string, code = 200) {
  return reply.code(code).send({
    success: true,
    ...(msg ? { msg } : {}),
    ...(data !== undefined ? { data } : {}),
  });
}

/**
 * 统一标准 API 错误响应
 */
export function sendError(reply: FastifyReply, msg: string, code = 400, extra?: Record<string, unknown>) {
  return reply.code(code).send({
    success: false,
    msg,
    ...(extra || {}),
  });
}
