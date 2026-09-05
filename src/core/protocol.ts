import crypto from 'node:crypto';

/**
 * 天翼云电脑底层核心协议与安全算法 (纯净极简版，剔除原版死代码与第三方依赖)
 */
export class Protocol {
  public static buildClinkHeader(channelType = 1, channelId = 0, channelCaps = 4): Buffer {
    const result = Buffer.alloc(42);
    result.write('REDQ', 0, 'ascii');
    result.writeUInt32LE(2, 4);
    result.writeUInt32LE(2, 8);
    result.writeUInt32LE(26, 12);
    result.writeUInt8(channelType, 20);
    result.writeUInt8(channelId, 21);
    result.writeUInt32LE(1, 22);
    result.writeUInt32LE(1, 26);
    result.writeUInt32LE(18, 30);
    result.writeUInt32LE(9, 34);
    result.writeUInt32LE(channelCaps, 38);
    return result;
  }

  public static buildClinkTicket(linkHeader: Buffer): Buffer {
    const keyOffsets = [20, 4];
    let key: crypto.KeyObject | undefined;
    for (const offset of keyOffsets) {
      const der = linkHeader.subarray(offset, offset + 162);
      if (der.length < 162) continue;
      try {
        key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
        break;
      } catch {}
    }
    if (!key) throw new Error('CLINK 公钥位置无法识别');
    const jwk = key.export({ format: 'jwk' }) as { n: string; e: string };
    const modulus = BigInt(`0x${Buffer.from(jwk.n, 'base64url').toString('hex')}`);
    const exponent = BigInt(`0x${Buffer.from(jwk.e, 'base64url').toString('hex')}`);
    const seed = crypto.randomBytes(20);
    const labelHash = crypto.createHash('sha1').update('').digest();
    const dataBlock = Buffer.concat([labelHash, Buffer.alloc(85), Buffer.from([1, 0])]);
    const dbMask = this.mgf1(seed, dataBlock.length);
    for (let i = 0; i < dataBlock.length; i++) dataBlock[i] ^= dbMask[i];
    const seedMask = this.mgf1(dataBlock, seed.length);
    for (let i = 0; i < seed.length; i++) seed[i] ^= seedMask[i];
    const encoded = Buffer.concat([Buffer.from([0]), seed, dataBlock]);
    const encryptedBigInt = this.modPow(
      BigInt(`0x${encoded.toString('hex')}`),
      exponent,
      modulus,
    );
    const encrypted = Buffer.from(encryptedBigInt.toString(16).padStart(256, '0'), 'hex');
    const result = Buffer.alloc(132);
    result.writeUInt32LE(1, 0);
    encrypted.copy(result, 4);
    return result;
  }

  public static buildMessage(type: number, data?: Buffer): Buffer {
    const result = Buffer.alloc(6 + (data?.length || 0));
    result.writeUInt16LE(type, 0);
    result.writeUInt32LE(data?.length || 0, 2);
    data?.copy(result, 6);
    return result;
  }

  public static buildClientUserName(userName: string, userId: number): Buffer {
    const json = Buffer.from(JSON.stringify({ type: 1, userName, userInfo: '', userId }), 'utf8');
    const data = Buffer.alloc(8 + json.length);
    data.writeUInt32LE(json.length, 0);
    data.writeUInt32LE(8, 4);
    json.copy(data, 8);
    return this.buildMessage(118, data);
  }

  public static buildMainClientLoginInfo(
    desktopId: string,
    token: string,
    deviceType: string,
    deviceCode: string,
    userAccount: string,
  ): Buffer {
    const values = [token, deviceType, deviceCode, userAccount].map((value) => Buffer.from(value, 'utf8'));
    const body = Buffer.alloc(36 + values.reduce((sum, value) => sum + value.length + 1, 0));
    body.writeUInt32LE(Number(desktopId), 0);
    let offset = 36;
    values.forEach((value, index) => {
      body.writeUInt32LE(value.length + 1, index * 8 + 4);
      body.writeUInt32LE(offset, index * 8 + 8);
      value.copy(body, offset);
      offset += value.length + 1;
    });
    return this.buildMessage(112, body);
  }
  /**
   * 计算 MD5 16 进制小写
   */
  public static md5(str: string): string {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase();
  }

  /**
   * 计算 SHA256 16 进制小写
   */
  public static sha256(str: string): string {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex').toLowerCase();
  }

  /**
   * MGF1 掩码生成函数 (基于 SHA-1)
   */
  public static mgf1(seed: Buffer, maskLen: number): Buffer {
    const mask = Buffer.alloc(maskLen);
    let offset = 0;
    let counter = 0;

    while (offset < maskLen) {
      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(counter, 0);

      const hash = crypto
        .createHash('sha1')
        .update(Buffer.concat([seed, counterBuf]))
        .digest();

      const copyLen = Math.min(hash.length, maskLen - offset);
      hash.copy(mask, offset, 0, copyLen);

      offset += hash.length;
      counter++;
    }

    return mask;
  }

  /**
   * 大整数快速幂取模: (base ^ exp) mod mod
   */
  public static modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let res = 1n;
    let b = base % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) {
        res = (res * b) % mod;
      }
      e >>= 1n;
      b = (b * b) % mod;
    }
    return res;
  }

}
