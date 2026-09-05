import https from 'node:https';
import { Protocol } from './protocol.js';
import { safeFetch } from './utils.js';

function requestIpv4(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; headers: Record<string, any>; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const timeoutMs = options.timeoutMs || 60000;
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        family: 4,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 200,
            headers: res.headers,
            json: () => {
              try {
                return Promise.resolve(JSON.parse(data));
              } catch (e) {
                return Promise.resolve(data);
              }
            },
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (${timeoutMs}ms): ${urlStr}`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

export interface ChallengeData {
  effectiveSeconds: number;
  challengeId: string;
  challengeCode: string;
}

export interface LoginInfo {
  userAccount: string;
  bondedDevice: boolean;
  secretKey: string;
  userId: number;
  tenantId: number;
  userName: string;
}

export interface DesktopInfo {
  desktopId: number;
  host: string;
  port: string;
  clinkLvsOutHost: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  token: string;
  tenantMemberAccount: string;
}

export interface Desktop {
  desktopId: string;
  desktopName: string;
  desktopCode: string;
  useStatusText: string;
  desktopInfo?: DesktopInfo;
  imageName?: string;
  flavorName?: string;
  objType?: number; // 0: 普通单机, 1: 政企桌面池, 2: 抢占式
  objId?: string;
  poolId?: string;
  isPool?: boolean;
}

export class CtYunClient {
  public static readonly VERSION = '103020001';
  public static readonly DEVICE_TYPE = '60';
  public static readonly BASE_URL = 'https://desk.ctyun.cn:8810';
  public readonly baseUrl = CtYunClient.BASE_URL;

  private deviceCode: string;
  public loginInfo: LoginInfo | null = null;

  constructor(deviceCode: string) {
    this.deviceCode = deviceCode;
  }

  public getDeviceCode(): string {
    return this.deviceCode;
  }

  /**
   * 签名请求头
   */
  public getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'ctg-devicetype': CtYunClient.DEVICE_TYPE,
      'ctg-version': CtYunClient.VERSION,
      'ctg-devicecode': this.deviceCode,
      Referer: 'https://pc.ctyun.cn/',
    };

    if (this.loginInfo) {
      const timestamp = Date.now().toString();
      headers['ctg-userid'] = this.loginInfo.userId.toString();
      headers['ctg-tenantid'] = this.loginInfo.tenantId.toString();
      headers['ctg-timestamp'] = timestamp;
      headers['ctg-requestid'] = timestamp;

      const signStr = `${CtYunClient.DEVICE_TYPE}${timestamp}${this.loginInfo.tenantId}${timestamp}${this.loginInfo.userId}${CtYunClient.VERSION}${this.loginInfo.secretKey}`;
      headers['ctg-signaturestr'] = Protocol.md5(signStr);
    }

    return headers;
  }

  /**
   * 1. 获取安全挑战数据
   */
  public async getChallengeData(): Promise<ChallengeData> {
    const res = await safeFetch(`${CtYunClient.BASE_URL}/api/auth/client/genChallengeData`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const json = (await res.json()) as { code: number; msg?: string; data: ChallengeData };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(`获取挑战数据失败: ${json.msg || '未知错误'}`);
    }
    return json.data;
  }

  /**
   * 2. 获取登录图形验证码图片 Buffer
   */
  public async getLoginCaptcha(userPhone: string): Promise<Buffer> {
    const timestamp = Date.now();
    const url = `${CtYunClient.BASE_URL}/api/auth/client/captcha?height=36&width=85&userInfo=${encodeURIComponent(
      userPhone,
    )}&mode=auto&_t=${timestamp}`;
    const res = await safeFetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`获取图形验证码失败: HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * 3. 提交登录
   */
  public async login(
    userPhone: string,
    passwordPlain: string,
    challenge: ChallengeData,
    captchaCode: string,
  ): Promise<LoginInfo> {
    const pwdSha = Protocol.sha256(passwordPlain);
    const passwordHashed = Protocol.sha256(passwordPlain + challenge.challengeCode);
    const sha256Password = Protocol.sha256(pwdSha + challenge.challengeCode);

    const formData = new URLSearchParams();
    formData.append('userAccount', userPhone);
    formData.append('password', passwordHashed);
    formData.append('sha256Password', sha256Password);
    formData.append('challengeId', challenge.challengeId);
    formData.append('captchaCode', captchaCode);
    formData.append('deviceCode', this.deviceCode);
    formData.append('deviceName', 'Chrome浏览器');
    formData.append('deviceType', CtYunClient.DEVICE_TYPE);
    formData.append('deviceModel', 'Windows NT 10.0; Win64; x64');
    formData.append('appVersion', '3.2.0');
    formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
    formData.append('clientVersion', CtYunClient.VERSION);

    const res = await safeFetch(`${CtYunClient.BASE_URL}/api/auth/client/login`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const json = (await res.json()) as { code: number; msg?: string; data: LoginInfo };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '登录失败');
    }

    this.loginInfo = json.data;
    return json.data;
  }

  /**
   * 4. 获取绑定设备短信图形验证码
   */
  public async getSmsCodeCaptcha(): Promise<{ image: Buffer; captchaKey: string }> {
    const timestamp = Date.now();
    const url = `${CtYunClient.BASE_URL}/api/auth/client/validateCode/captcha?width=120&height=40&_t=${timestamp}`;
    const res = await safeFetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`获取短信验证码图验失败: HTTP ${res.status}`);
    }
    const captchaKey = res.headers.get('ctg-captcha-key') || res.headers.get('CTG-CAPTCHA-KEY') || '';
    const arrayBuffer = await res.arrayBuffer();
    return { image: Buffer.from(arrayBuffer), captchaKey };
  }

  /**
   * 5. 发送短信验证码 (官方要求携带 captchaCodeKey 与 CTG-SMS-KEY 提取)
   */
  public async sendSmsCode(userPhone: string, captchaCode: string, captchaCodeKey = ''): Promise<{ success: boolean; smsKey: string }> {
    let url = `${CtYunClient.BASE_URL}/api/cdserv/client/device/getSmsCode?mobilePhone=${encodeURIComponent(
      userPhone,
    )}&captchaCode=${encodeURIComponent(captchaCode)}`;
    if (captchaCodeKey) {
      url += `&captchaCodeKey=${encodeURIComponent(captchaCodeKey)}`;
    }
    const res = await safeFetch(url, {
      headers: this.getHeaders(),
    });
    const smsKey = res.headers.get('ctg-sms-key') || res.headers.get('CTG-SMS-KEY') || '';
    const json = (await res.json()) as { code: number; msg?: string };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '发送短信验证码失败');
    }
    return { success: true, smsKey };
  }

  /**
   * 6. 绑定设备 (官方要求携带 verificationCode 与 smsCodeKey)
   */
  public async bindDevice(verificationCode: string, smsCodeKey = ''): Promise<boolean> {
    const formData = new URLSearchParams();
    formData.append('verificationCode', verificationCode.trim());
    if (smsCodeKey) {
      formData.append('smsCodeKey', smsCodeKey.trim());
    }
    formData.append('deviceName', 'Chrome浏览器');
    formData.append('deviceCode', this.deviceCode);
    formData.append('deviceModel', 'Windows NT 10.0; Win64; x64');
    formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
    formData.append('appVersion', '3.7.0');
    formData.append('hostName', 'pc.ctyun.cn');
    formData.append('deviceInfo', 'Win32');

    const url = `${CtYunClient.BASE_URL}/api/cdserv/client/device/binding`;
    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const json = (await res.json()) as { code: number; msg?: string };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '绑定设备失败');
    }
    if (this.loginInfo) {
      this.loginInfo.bondedDevice = true;
    }
    return true;
  }

  /**
   * 7. 解析聚合云电脑列表 (兼容普通单机 NORMAL、政企桌面池 POOL 与抢占式 Preemption)
   */
  private static parseDesktopItems(data: {
    desktopList?: any[];
    desktopPoolList?: any[];
    preemptionDesktopList?: any[];
  }): Desktop[] {
    const results: Desktop[] = [];

    // 1. 普通单机 (公众版 / 个人独立分配机 / 精英版 / 尊享版)
    if (Array.isArray(data.desktopList)) {
      for (const item of data.desktopList) {
        results.push({
          desktopId: String(item.desktopId || item.objId),
          desktopName: item.desktopName || '天翼云电脑',
          desktopCode: item.desktopCode || '',
          useStatusText: item.useStatusText || item.useStatus || '运行中',
          imageName: item.imageName || '',
          flavorName: item.flavorName || item.prodGroupName || '',
          objType: item.objType ?? 0,
          objId: String(item.objId || item.desktopId),
          isPool: false,
        });
      }
    }

    // 2. 政企桌面池 (POOL，政企企业级核心形态)
    if (Array.isArray(data.desktopPoolList)) {
      for (const item of data.desktopPoolList) {
        const poolId = String(item.poolId || item.objId || item.desktopId || '');
        results.push({
          desktopId: String(item.desktopId || poolId),
          desktopName: item.poolName || item.desktopName || '天翼云电脑(政企桌面池)',
          desktopCode: item.desktopCode || poolId,
          useStatusText: item.useStatusText || item.useStatus || '运行中',
          imageName: item.imageName || '',
          flavorName: item.flavorName || item.prodGroupName || '政企版',
          objType: item.objType ?? 1,
          objId: poolId,
          poolId,
          isPool: true,
        });
      }
    }

    // 3. 抢占式桌面 (Preemption)
    if (Array.isArray(data.preemptionDesktopList)) {
      for (const item of data.preemptionDesktopList) {
        const objId = String(item.objId || item.desktopId || '');
        results.push({
          desktopId: String(item.desktopId || objId),
          desktopName: item.desktopName || '天翼云电脑(抢占式)',
          desktopCode: item.desktopCode || objId,
          useStatusText: item.useStatusText || item.useStatus || '运行中',
          imageName: item.imageName || '',
          flavorName: item.flavorName || item.prodGroupName || '',
          objType: item.objType ?? 2,
          objId,
          isPool: false,
        });
      }
    }

    return results;
  }

  /**
   * 7. 拉取云电脑列表 (优先官方标准 /api/desktop/client/list，备用 /api/desktop/client/pageDesktop)
   */
  public async getDesktopList(): Promise<Desktop[]> {
    try {
      const listUrl = `${CtYunClient.BASE_URL}/api/desktop/client/list`;
      const res = await safeFetch(listUrl, {
        headers: this.getHeaders(),
      });
      if (res.status === 200) {
        const json = (await res.json()) as {
          code: number;
          msg?: string;
          data: {
            desktopList?: any[];
            desktopPoolList?: any[];
            preemptionDesktopList?: any[];
          };
        };
        if (json.code === 0 && json.data) {
          const list = CtYunClient.parseDesktopItems(json.data);
          if (list.length > 0) return list;
        }
      }
    } catch {}

    const res = await safeFetch(`${CtYunClient.BASE_URL}/api/desktop/client/pageDesktop`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        getCnt: 30,
        desktopTypes: ['1', '2001', '2002', '2003'],
        sortType: 'createTimeV1',
      }),
    });

    const json = (await res.json()) as {
      code: number;
      msg?: string;
      data: {
        desktopList?: any[];
        desktopPoolList?: any[];
        preemptionDesktopList?: any[];
      };
    };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '获取云电脑列表失败');
    }
    return CtYunClient.parseDesktopItems(json.data || {});
  }

  /**
   * 8. 获取云电脑连接信息 (WebSocket host & 证书凭证)
   * 完全对齐官方进入云电脑标准：支持普通机直连与政企桌面池动态分派连接
   */
  public async connectDesktop(desktopIdOrObj: string | Desktop, objType = 0): Promise<DesktopInfo> {
    const desktopId = typeof desktopIdOrObj === 'string' ? desktopIdOrObj : desktopIdOrObj.desktopId;
    const targetObjType = typeof desktopIdOrObj === 'string' ? objType : (desktopIdOrObj.objType ?? objType);
    const targetObjId = typeof desktopIdOrObj === 'string' ? desktopId : (desktopIdOrObj.objId || desktopIdOrObj.poolId || desktopId);

    // 1. 优先通过官方首选 status 接口获取桌面连接与证书信息 (普通单机优先)
    if (targetObjType === 0) {
      try {
        const statusUrl = `${CtYunClient.BASE_URL}/api/desktop/client/status?desktopId=${desktopId}&specifiedCertCategory=1`;
        const sRes = await safeFetch(statusUrl, { headers: this.getHeaders() });
        const sJson = (await sRes.json()) as { code: number; msg?: string; data?: { desktopInfo: DesktopInfo } };
        if (sJson.code === 0 && sJson.data?.desktopInfo?.clinkLvsOutHost) {
          return sJson.data.desktopInfo;
        }
      } catch {}
    }

    // 2. 备用通过 connect 接口获取 (政企桌面池必须使用 connect 接口并下发真实 objType)
    const formData = new URLSearchParams();
    formData.append('objId', targetObjId);
    formData.append('objType', String(targetObjType));
    formData.append('osType', '15');
    formData.append('deviceId', CtYunClient.DEVICE_TYPE);
    formData.append('vdCommand', '');
    formData.append('ipAddress', '');
    formData.append('macAddress', '');
    formData.append('deviceCode', this.deviceCode);
    formData.append('deviceName', 'Chrome浏览器');
    formData.append('deviceType', CtYunClient.DEVICE_TYPE);
    formData.append('deviceModel', 'Windows NT 10.0; Win64; x64');
    formData.append('desktopId', String(desktopId));
    formData.append('clientVersion', CtYunClient.VERSION);
    formData.append('specifiedCertCategory', '1');

    try {
      const res = await safeFetch(`${CtYunClient.BASE_URL}/api/desktop/client/connect`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const json = (await res.json()) as {
        code: number;
        msg?: string;
        data?: { desktopInfo?: DesktopInfo };
      };
      if (json.code === 0 && json.data?.desktopInfo?.clinkLvsOutHost) {
        return json.data.desktopInfo;
      }
    } catch {}

    throw new Error('获取连接信息失败');
  }

  /**
   * 8.0 模拟官方上报活动事件与桌面进入事件 (推进「登录AI云电脑」任务)
   */
  public async operateDesktop(
    desktopId: string,
    operation: 'on' | 'shutdown' | 'reset',
    objType = 0,
  ): Promise<string> {
    const typeMap: Record<'on' | 'shutdown' | 'reset', number> = { on: 1, shutdown: 2, reset: 3 };
    const opType = typeMap[operation] || 1;
    const formData = new URLSearchParams();
    formData.append('desktopId', desktopId);
    formData.append('objId', desktopId);
    formData.append('objType', String(objType));
    formData.append('operationType', String(opType));

    const res = await safeFetch(`${CtYunClient.BASE_URL}/api/desktop/client/operate`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const json = (await res.json()) as { code: number; msg?: string };
    if (json.code === 0) {
      const opNames: Record<'on' | 'shutdown' | 'reset', string> = {
        on: '开机指令已下发，正在启动...',
        shutdown: '关机指令已下发...',
        reset: '重启指令已下发，正在重启...',
      };
      return opNames[operation];
    }
    // 特殊容错：若提示“只有已关机状态允许进行开机操作”，说明已在运行中或正在开机，平滑接管
    if (operation === 'on' && (json.code === 30010 || json.msg?.includes('已关机状态'))) {
      return '云电脑已在运行中或开机流程中';
    }
    throw new Error(json.msg || `操作失败 (Code: ${json.code})`);
  }
}
