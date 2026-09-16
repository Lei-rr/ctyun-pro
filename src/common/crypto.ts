import crypto from 'node:crypto';

/**
 * 安全时间常量字符串比对 (防时序攻击)
 */
export function safeTimingEqual(a?: string, b?: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// 别名导出，兼容原有的 timingSafeEqualString 命名
export const timingSafeEqualString = safeTimingEqual;

/**
 * 校验口令散列对比 (兼容直接比对与 SHA256 散列比对)
 */
export function verifyPasswordHash(providedPassword: string, expectedHashOrPassword: string): boolean {
  if (!providedPassword || !expectedHashOrPassword) return false;
  const providedHash = crypto.createHash('sha256').update(providedPassword).digest('hex');
  return safeTimingEqual(providedPassword, expectedHashOrPassword) || safeTimingEqual(providedHash, expectedHashOrPassword);
}
