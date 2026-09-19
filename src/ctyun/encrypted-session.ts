import { Protocol } from '../clink/protocol.js';

/**
 * 官方请求体加密会话 (对齐 pc.ctyun.cn 的 negotiationEncKey / encryptRequestData)
 *
 * 流程:
 * 1. GET /api/cdserv/client/getServData，检查 globalSwitches.bodyMsgEType 是否含 "2"(AES_CBC)
 * 2. 生成 RSA-2048 OAEP(SHA-512) 密钥对，POST /api/auth/client/negotiationEncKey
 *    上报 SPKI 公钥，服务端返回 { encKey(公钥加密的AES密钥), encData(加密的会话数据) }
 * 3. 本地 RSA 解密得到 AES 密钥，AES-CBC 解密 encData 得到 { eid, evalue }
 * 4. 后续 POST/PUT 请求体使用 evalue 做 AES-128-CBC 加密，并附加头:
 *      CTG-REQDATA-ETYPE: "2"      (AES_CBC)
 *      CTG-NEGO-EKEYID:  <eid>
 *    响应若带 ctg-rspdata-etype=2 且含 edata 字段，使用 evalue 解密
 */

const ETYPE_AES_CBC = '2';
const HEADER_ETYPE = 'ctg-reqdata-etype';
const HEADER_EKEYID = 'ctg-nego-ekeyid';

export class EncryptedSession {
  private eid = '';
  private evalue = '';
  private negotiating: Promise<void> | null = null;

  public get enabled(): boolean {
    return Boolean(this.eid && this.evalue);
  }

  /** 将请求头补全为加密态 (POST/PUT 时由调用方加密 body) */
  public applyHeaders(headers: Record<string, string>): Record<string, string> {
    if (!this.enabled) return headers;
    headers[HEADER_ETYPE] = ETYPE_AES_CBC;
    headers[HEADER_EKEYID] = this.eid;
    return headers;
  }

  /** 加密 JSON 请求体；未启用时原样返回 */
  public encryptBody(body: unknown): string {
    const plain = JSON.stringify(body);
    if (!this.enabled) return plain;
    return JSON.stringify({ data: Protocol.encryptAesCbc(plain, this.evalue) });
  }

  /**
   * 加密表单请求体
   * 官方实现: eParams = AES(JSON.stringify(data))  (实测: 传 querystring 会返回 30090 数据解密失败)
   */
  public encryptForm(params: Record<string, string>): string {
    if (!this.enabled) return new URLSearchParams(params).toString();
    return new URLSearchParams({
      eParams: Protocol.encryptAesCbc(JSON.stringify(params), this.evalue),
    }).toString();
  }

  /** 加密 GET 查询串 (官方: eUrlParams=<AES(querystring)>) */
  public encryptQuery(query: string): string {
    if (!this.enabled || !query) return query ? `?${query}` : '';
    return `?eUrlParams=${encodeURIComponent(Protocol.encryptAesCbc(query, this.evalue))}`;
  }

  /**
   * 解密响应体；若服务端未加密或响应非 edata 结构则原样返回
   * 支持 { edata: string } 或直通 JSON
   */
  public decryptResponse<T = unknown>(json: T): T {
    if (!this.enabled) return json;
    const obj = json as unknown as Record<string, unknown>;
    if (obj && typeof obj === 'object' && typeof obj['edata'] === 'string') {
      try {
        return JSON.parse(Protocol.decryptAesCbc(obj['edata'] as string, this.evalue)) as T;
      } catch {
        return json;
      }
    }
    return json;
  }

  /**
   * 执行密钥协商 (幂等；并发调用只协商一次)
   * @param getServData 拉取服务端开关
   * @param negotiate  POST negotiationEncKey，返回 { encKey, encData }
   */
  public async negotiate(
    baseUrl: string,
    buildHeaders: () => Record<string, string>,
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  ): Promise<void> {
    if (this.enabled) return;
    if (this.negotiating) return this.negotiating;

    this.negotiating = (async () => {
      try {
        const servRes = await fetchImpl(`${baseUrl}/api/cdserv/client/getServData`, {
          headers: buildHeaders(),
        });
        const servJson = (await servRes.json()) as {
          code: number;
          data?: { globalSwitches?: { bodyMsgEType?: string[] } };
        };
        const types = servJson.data?.globalSwitches?.bodyMsgEType || [];
        if (servJson.code !== 0 || !types.includes(ETYPE_AES_CBC)) {
          return;
        }

        const { publicKeyB64, privateKeyPem } = Protocol.generateRsaKeyPair();
        const negRes = await fetchImpl(`${baseUrl}/api/auth/client/negotiationEncKey`, {
          method: 'POST',
          headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ etype: ETYPE_AES_CBC, certType: ETYPE_AES_CBC, certData: publicKeyB64 }),
        });
        const negJson = (await negRes.json()) as {
          code: number;
          data?: { encKey?: string; encData?: string; eid?: string };
        };
        if (negJson.code !== 0 || !negJson.data?.encKey || !negJson.data.encData) return;

        const aesKey = Protocol.decryptRsaPkcs1(negJson.data.encKey, privateKeyPem);
        const plain = Protocol.decryptAesCbc(negJson.data.encData, aesKey);
        const parsed = JSON.parse(plain) as { eid?: string; evalue?: string };
        if (parsed.eid && parsed.evalue) {
          this.eid = parsed.eid;
          this.evalue = parsed.evalue;
        }
      } catch {
        // 协商失败按明文直连 (官方亦为静默降级)
      } finally {
        this.negotiating = null;
      }
    })();

    return this.negotiating;
  }

  /** 重置会话 (切换账号时调用) */
  public reset(): void {
    this.eid = '';
    this.evalue = '';
    this.negotiating = null;
  }
}
