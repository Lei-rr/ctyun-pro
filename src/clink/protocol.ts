import crypto from 'node:crypto';

/**
 * 天翼云官方 Clink 消息类型定义
 * 服务端下发 (CLINK_MSG_*) 与 客户端上报 (CLINK_MSGC_*)
 */
export enum ClinkMsgType {
  // === 客户端上报 (Client -> Server) ===
  MSGC_ACK_SYNC = 1, // 客户端 ACK 窗口同步响应
  MSGC_ACK = 2, // 客户端 ACK
  MSGC_PONG = 3, // 客户端回复 Pong (响应服务端的 Type 4 Ping)
  PONG = 3, // 兼容别名
  MSGC_MIGRATE_FLUSH_MARK = 4,
  MSGC_MIGRATE_DATA = 5,
  MSGC_DISCONNECTING = 6,
  MSGC_HEARTBEAT = 7, // 客户端主动活跃心跳 (30s 心跳保活)
  HEARTBEAT = 7, // 兼容别名
  MSGC_MAIN_CLIENT_INFO = 101,
  MSGC_MAIN_ATTACH_CHANNELS = 104, // 客户端声明通道挂接就绪
  MAIN_ATTACH_CHANNELS = 104, // 兼容别名
  MSGC_MAIN_CLIENT_LOGIN_INFO = 112, // 客户端向主通道认领桌面会话凭证
  MAIN_CLIENT_LOGIN_INFO = 112, // 兼容别名
  MSGC_MAIN_APP_STATUS_FRONT = 113, // 声明应用前台激活
  MSGC_MAIN_APP_STATUS_BACK = 114, // 声明应用后台静默
  MSGC_MAIN_GET_CLINK_VERSION = 116, // 查询 Clink 版本
  MSGC_MAIN_CLIENT2SERVER_CUSTOM = 118, // 客户端回传自定义 JSON (用户身份)
  USER_IDENTITY_RESPONSE = 118, // 兼容别名
  MSGC_END_MAIN = 120,

  // === 服务端下发 (Server -> Client) ===
  MSG_MIGRATE = 1,
  MSG_MIGRATE_DATA = 2,
  MSG_SET_ACK = 3, // 服务端 ACK 窗口协商下发
  SET_ACK = 3, // 兼容别名
  MSG_PING = 4, // 服务端心跳 Ping 探测
  PING = 4, // 兼容别名
  MSG_WAIT_FOR_CHANNELS = 5,
  MSG_DISCONNECTING = 6, // 服务端通知即将断开
  MSG_NOTIFY = 7,
  MSG_LIST = 8,
  MSG_HEARTBEAT_RES = 9, // 服务端心跳确认回执 (CLINK_MSG_HEARTBEAT_RES)
  HEARTBEAT_RES = 9, // 官方标准心跳回执
  MSG_MAIN_INIT = 103, // 服务端主通道握手初始化信令
  USER_STATUS_PROBE = 103, // 兼容别名
  MSG_MAIN_CHANNELS_LIST = 104,
  MSG_MAIN_CLIENT_OFFLINE = 119, // 服务端通知客户端离线 / 会话剔除
  SESSION_KICK = 119, // 兼容别名
  MSG_MAIN_DESKTOP_LOCKED = 120, // 外部客户端挤占锁定桌面
  SESSION_PREEMPTION = 120, // 兼容别名
  MSG_MAIN_MGR_MESSAGE = 121,
  MSG_MAIN_SERVER2CLIENT_CUSTOM = 127,
  MSG_MAIN_CLIENT_LOGIN_INFO_RES = 136, // 登录认领结果回执
  MSG_END_MAIN = 137, // 服务端结束主通道
  SESSION_RESET = 137, // 兼容别名
}

/**
 * 天翼云电脑底层核心协议与安全算法 (纯净极简版，剔除原版死代码与第三方依赖)
 */
export class Protocol {
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

  /**
   * 官方规范: 客户端 ACK 窗口同步响应 (Type 1 CLINK_MSGC_ACK_SYNC)
   */
  public static buildAckSync(generation: number): Buffer {
    const data = Buffer.alloc(4);
    data.writeUInt32LE(generation, 0);
    return this.buildMessage(ClinkMsgType.MSGC_ACK_SYNC, data);
  }

  /**
   * 官方规范: 客户端通道挂接就绪通知 (Type 104 CLINK_MSGC_MAIN_ATTACH_CHANNELS)
   */
  public static buildAttachChannels(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_MAIN_ATTACH_CHANNELS);
  }

  /**
   * 官方规范: 响应服务端 Type 4 Ping 探测 -> 回复 Type 3 Pong
   * 官方行为: Pong 必须回显 Ping 报文前 12 字节数据 (handlePing: t.data = e.data.slice(0, 12))
   */
  public static buildPong(echoData?: Buffer): Buffer {
    const data = echoData && echoData.length > 0 ? echoData.subarray(0, 12) : undefined;
    return this.buildMessage(ClinkMsgType.MSGC_PONG, data);
  }

  /**
   * 官方规范: 客户端 ACK (Type 2 CLINK_MSGC_ACK) 滑动窗口确认
   */
  public static buildAck(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_ACK);
  }

  /**
   * 官方规范: 客户端 30s 周期性活跃心跳报文 (Type 7)
   */
  public static buildHeartbeat(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_HEARTBEAT);
  }

  public static buildClientUserName(userName: string, userId: number): Buffer {
    const json = Buffer.from(JSON.stringify({ type: 1, userName, userInfo: '', userId }), 'utf8');
    const data = Buffer.alloc(8 + json.length);
    data.writeUInt32LE(json.length, 0);
    data.writeUInt32LE(8, 4);
    json.copy(data, 8);
    return this.buildMessage(118, data);
  }

  /**
   * 官方规范: 客户端获取 Clink 版本报文 (Type 116 CLINK_MSGC_MAIN_GET_CLINK_VERSION)
   */
  public static buildGetClinkVersion(): Buffer {
    return this.buildMessage(ClinkMsgType.MSGC_MAIN_GET_CLINK_VERSION);
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
  /** 解析服务端 REDQ 保活校验帧，使用其 RSA 公钥生成加密回执 */
  public static buildRedqResponse(linkHeader: Buffer): Buffer {
    return this.buildClinkTicket(linkHeader);
  }

  /**
   * 解析服务端下发的 CLINK 协议消息
   */
  public static parseSendInfo(buffer: Buffer): Array<{ type: number; data: Buffer }> {
    const results: Array<{ type: number; data: Buffer }> = [];
    if (buffer.length < 6) return results;

    let offset = 0;
    while (offset + 6 <= buffer.length) {
      const type = buffer.readUInt16LE(offset);
      const size = buffer.readUInt32LE(offset + 2);
      if (size < 0 || offset + 6 + size > buffer.length) {
        break;
      }
      // 官方 resolveMessage 语义: type=0 为空占位/填充帧，直接丢弃且不计入 ACK
      // (服务端会下发 4096B 全零帧；若计入会产生 682 条假消息与无效 ACK 风暴)
      if (type !== 0) {
        const data = buffer.subarray(offset + 6, offset + 6 + size);
        results.push({ type, data });
      } else if (size === 0) {
        // 连续空占位帧，无有效载荷，终止扫描避免无效遍历
        let allZero = true;
        for (let i = offset; i < buffer.length; i++) {
          if (buffer[i] !== 0) { allZero = false; break; }
        }
        if (allZero) break;
      }
      offset += 6 + size;
    }
    return results;
  }

  /**
   * 官方请求体 AES-CBC 加密 (对齐官方 FQ)
   * 实测: key 取自 evalue 的 Utf8 全字节 (32B -> AES-256-CBC)，IV 为全零 16 字节，PKCS7
   */
  public static encryptAesCbc(plaintext: string, key: string): string {
    const keyBuf = Buffer.from(key, 'utf8');
    const algo = keyBuf.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
    const cipher = crypto.createCipheriv(algo, keyBuf, Buffer.alloc(16, 0));
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
  }

  /**
   * 官方响应体 AES-CBC 解密 (对齐官方 F6)
   */
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

  /**
   * 解密服务端用我方 RSA 公钥加密的 AES 密钥
   * 官方经 JSEncrypt.decrypt 处理 (PKCS1 v1.5 填充)，实测确认
   */
  public static decryptRsaPkcs1(ciphertextBase64: string, privateKeyPem: string): string {
    return crypto
      .privateDecrypt(
        { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(ciphertextBase64, 'base64'),
      )
      .toString('utf8');
  }

  /**
   * 生成 RSA-2048 OAEP(SHA-512) 密钥对 (SPKI 公钥 + PKCS8 私钥, base64)
   */
  public static generateRsaKeyPair(): { publicKeyB64: string; privateKeyPem: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKeyB64: (publicKey as Buffer).toString('base64'), privateKeyPem: privateKey as string };
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
