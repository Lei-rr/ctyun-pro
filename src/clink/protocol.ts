import crypto from 'node:crypto';

/**
 * 天翼云官方 Clink 消息类型 (仅保留实际收发用到的子集)
 * 服务端下发 CLINK_MSG_* / 客户端上报 CLINK_MSGC_*，与官方 pc_main.js 常量表对齐
 */
export enum ClinkMsgType {
  // 客户端上报
  MSGC_ACK_SYNC = 1, // ACK 窗口同步响应
  MSGC_ACK = 2, // 滑动窗口 ACK
  MSGC_PONG = 3, // 回复服务端 Type 4 Ping
  MSGC_HEARTBEAT = 7, // 活跃心跳
  MSGC_MAIN_CLIENT_LOGIN_INFO = 112, // 认领桌面会话
  MSGC_MAIN_ATTACH_CHANNELS = 104, // 通道挂接就绪
  MSGC_MAIN_GET_CLINK_VERSION = 116, // 查询 Clink 版本
  MSGC_MAIN_CLIENT2SERVER_CUSTOM = 118, // 自定义 JSON 上报 (用户身份)

  // 服务端下发
  MSG_SET_ACK = 3, // ACK 窗口协商
  MSG_PING = 4, // Ping 探测
  MSG_HEARTBEAT_RES = 9, // 心跳回执
  MSG_MAIN_INIT = 103, // 主通道握手初始化
  MSG_MAIN_CLIENT_OFFLINE = 119, // 客户端离线 / 会话剔除
  MSG_MAIN_DESKTOP_LOCKED = 120, // 外部客户端挤占锁定
  MSG_MAIN_CLIENT_LOGIN_INFO_RES = 136, // 登录认领回执
  MSG_END_MAIN = 137, // 结束主通道
}

/**
 * 天翼云电脑底层协议与安全算法
 *
 * 证书票据 (REDQ) 说明: 首帧握手载荷为抓包所得固定帧，官方 bundle 中
 * link header 的 pub_key 字段在 Web 端未被赋值 (恒为 undefined)，无法从
 * 前端源码推导，故保留固定帧并维持已生产验证的回执算法。
 */
export class Protocol {
  private static buildMessage(type: number, data?: Buffer): Buffer {
    const result = Buffer.alloc(6 + (data?.length || 0));
    result.writeUInt16LE(type, 0);
    result.writeUInt32LE(data?.length || 0, 2);
    data?.copy(result, 6);
    return result;
  }

  /** Type 1 ACK 窗口同步响应 */
  public static buildAckSync(generation: number): Buffer {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(generation, 0);
    return this.buildMessage(ClinkMsgType.MSGC_ACK_SYNC, data);
  }

  /** Type 104 通道挂接就绪 */
  public static buildAttachChannels(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_MAIN_ATTACH_CHANNELS);
  }

  /** Type 3 Pong，官方回显 Ping 报文前 12 字节 */
  public static buildPong(echoData?: Buffer): Buffer {
    const data = echoData && echoData.length > 0 ? echoData.subarray(0, 12) : undefined;
    return this.buildMessage(ClinkMsgType.MSGC_PONG, data);
  }

  /** Type 2 滑动窗口 ACK */
  public static buildAck(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_ACK);
  }

  /** Type 7 活跃心跳 */
  public static buildHeartbeat(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_HEARTBEAT);
  }

  /** Type 118 用户身份 JSON (type=1 表示客户端用户名) */
  public static buildClientUserName(userName: string, userId: number): Buffer {
    const json = Buffer.from(JSON.stringify({ type: 1, userName, userInfo: '', userId }), 'utf8');
    const data = Buffer.alloc(8 + json.length);
    data.writeUInt32LE(json.length, 0);
    data.writeUInt32LE(8, 4);
    json.copy(data, 8);
    return this.buildMessage(ClinkMsgType.MSGC_MAIN_CLIENT2SERVER_CUSTOM, data);
  }

  /** Type 116 查询 Clink 版本 */
  public static buildGetClinkVersion(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_MAIN_GET_CLINK_VERSION);
  }

  /**
   * Type 112 会话认领 (对齐官方 class ja: desktopId + 4 组 [长度, 偏移] 变长字段)
   */
  public static buildMainClientLoginInfo(
    desktopId: string,
    token: string,
    deviceType: string,
    deviceCode: string,
    userAccount: string,
  ): Buffer {
    const values = [token, deviceType, deviceCode, userAccount].map((v) => Buffer.from(v, 'utf8'));
    const body = Buffer.alloc(36 + values.reduce((sum, v) => sum + v.length + 1, 0));
    body.writeUInt32LE(Number(desktopId), 0);
    let offset = 36;
    values.forEach((value, index) => {
      body.writeUInt32LE(value.length + 1, index * 8 + 4);
      body.writeUInt32LE(offset, index * 8 + 8);
      value.copy(body, offset);
      offset += value.length + 1;
    });
    return this.buildMessage(ClinkMsgType.MSGC_MAIN_CLIENT_LOGIN_INFO, body);
  }

  /** 响应服务端 REDQ 保活校验帧：以其内嵌 RSA 公钥做 PKCS#1 v1.5 加密回执 */
  public static buildRedqResponse(linkHeader: Buffer): Buffer {
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

    // PKCS#1 v1.5 填充: 0x00 || 0x01 || PS(0xFF) || 0x00 || DigestInfo(空摘要 SHA-1 占位)
    const seed = crypto.randomBytes(20);
    const labelHash = crypto.createHash('sha1').update('').digest();
    const dataBlock = Buffer.concat([labelHash, Buffer.alloc(85), Buffer.from([1, 0])]);
    const dbMask = this.mgf1(seed, dataBlock.length);
    for (let i = 0; i < dataBlock.length; i++) dataBlock[i] ^= dbMask[i];
    const seedMask = this.mgf1(dataBlock, seed.length);
    for (let i = 0; i < seed.length; i++) seed[i] ^= seedMask[i];

    const encoded = Buffer.concat([Buffer.from([0]), seed, dataBlock]);
    const encryptedBigInt = this.modPow(BigInt(`0x${encoded.toString('hex')}`), exponent, modulus);
    const encrypted = Buffer.from(encryptedBigInt.toString(16).padStart(256, '0'), 'hex');

    const result = Buffer.alloc(132);
    result.writeUInt32LE(1, 0);
    encrypted.copy(result, 4);
    return result;
  }

  /**
   * 解析服务端下发的 CLINK 协议消息
   * 官方 resolveMessage 语义: type=0 为空占位/填充帧 (服务端会下发 4096B 全零帧)，
   * 直接丢弃且不计入 ACK，避免无效 ACK 风暴
   */
  public static parseSendInfo(buffer: Buffer): Array<{ type: number; data: Buffer }> {
    const results: Array<{ type: number; data: Buffer }> = [];
    if (buffer.length < 6) return results;

    let offset = 0;
    while (offset + 6 <= buffer.length) {
      const type = buffer.readUInt16LE(offset);
      const size = buffer.readUInt32LE(offset + 2);
      if (size < 0 || offset + 6 + size > buffer.length) break;

      if (type !== 0) {
        results.push({ type, data: buffer.subarray(offset + 6, offset + 6 + size) });
      } else if (size === 0) {
        // 连续空占位帧: 检测到后续全零即终止扫描，避免 O(n²) 遍历
        let allZero = true;
        for (let i = offset; i < buffer.length; i++) {
          if (buffer[i] !== 0) {
            allZero = false;
            break;
          }
        }
        if (allZero) break;
      }
      offset += 6 + size;
    }
    return results;
  }

  /** 官方请求体 AES-CBC 加密；key 为 evalue 的 UTF-8 全字节，IV 全零，PKCS7 */
  public static encryptAesCbc(plaintext: string, key: string): string {
    const keyBuf = Buffer.from(key, 'utf8');
    const algo = keyBuf.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
    const cipher = crypto.createCipheriv(algo, keyBuf, Buffer.alloc(16, 0));
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
  }

  /** 官方响应体 AES-CBC 解密 */
  public static decryptAesCbc(ciphertextBase64: string, key: string): string {
    const keyBuf = Buffer.from(key, 'utf8');
    const algo = keyBuf.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
    const decipher = crypto.createDecipheriv(algo, keyBuf, Buffer.alloc(16, 0));
    decipher.setAutoPadding(true);
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextBase64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** 解密服务端用我方 RSA 公钥加密的 AES 密钥 (官方 JSEncrypt.decrypt 为 PKCS#1 v1.5) */
  public static decryptRsaPkcs1(ciphertextBase64: string, privateKeyPem: string): string {
    return crypto
      .privateDecrypt(
        { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(ciphertextBase64, 'base64'),
      )
      .toString('utf8');
  }

  /** 生成 RSA-2048 密钥对 (SPKI 公钥 base64 + PKCS8 私钥 PEM) */
  public static generateRsaKeyPair(): { publicKeyB64: string; privateKeyPem: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKeyB64: (publicKey as Buffer).toString('base64'), privateKeyPem: privateKey as string };
  }

  /** MD5 小写十六进制 (官方签名 generatorSignJS 依赖) */
  public static md5(str: string): string {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase();
  }

  /** SHA256 小写十六进制 */
  public static sha256(str: string): string {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex').toLowerCase();
  }

  /** MGF1 掩码生成 (基于 SHA-1) */
  private static mgf1(seed: Buffer, maskLen: number): Buffer {
    const mask = Buffer.alloc(maskLen);
    let offset = 0;
    let counter = 0;
    while (offset < maskLen) {
      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(counter, 0);
      const hash = crypto.createHash('sha1').update(Buffer.concat([seed, counterBuf])).digest();
      const copyLen = Math.min(hash.length, maskLen - offset);
      hash.copy(mask, offset, 0, copyLen);
      offset += hash.length;
      counter++;
    }
    return mask;
  }

  /** 大整数模幂 (base^exp mod mod) */
  private static modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let res = 1n;
    let b = base % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) res = (res * b) % mod;
      e >>= 1n;
      b = (b * b) % mod;
    }
    return res;
  }
}
