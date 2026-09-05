import https from 'node:https';
import { Protocol } from './protocol.js';

function requestIpv4(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: Record<string, any>; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        family: 4,
        rejectUnauthorized: false,
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
    const res = await fetch(`${CtYunClient.BASE_URL}/api/auth/client/genChallengeData`, {
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
    const res = await fetch(url, { headers: this.getHeaders() });
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

    const res = await fetch(`${CtYunClient.BASE_URL}/api/auth/client/login`, {
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
  public async getSmsCodeCaptcha(): Promise<Buffer> {
    const timestamp = Date.now();
    const url = `${CtYunClient.BASE_URL}/api/auth/client/validateCode/captcha?width=120&height=40&_t=${timestamp}`;
    const res = await fetch(url, { headers: this.getHeaders() });
    if (!res.ok) {
      throw new Error(`获取短信验证码图验失败: HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * 5. 发送短信验证码
   */
  public async sendSmsCode(userPhone: string, captchaCode: string): Promise<boolean> {
    const url = `${CtYunClient.BASE_URL}/api/cdserv/client/device/getSmsCode?mobilePhone=${encodeURIComponent(
      userPhone,
    )}&captchaCode=${encodeURIComponent(captchaCode)}`;
    const res = await fetch(url, {
      headers: this.getHeaders(),
    });
    const json = (await res.json()) as { code: number; msg?: string };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '发送短信验证码失败');
    }
    return true;
  }

  /**
   * 6. 绑定设备
   */
  public async bindDevice(verificationCode: string): Promise<boolean> {
    const url = `${CtYunClient.BASE_URL}/api/cdserv/client/device/binding?verificationCode=${encodeURIComponent(
      verificationCode,
    )}&deviceName=Chrome%E6%B5%8F%E8%A7%88%E5%99%A8&deviceCode=${encodeURIComponent(
      this.deviceCode,
    )}&deviceModel=Windows+NT+10.0%3B+Win64%3B+x64&sysVersion=Windows+NT+10.0%3B+Win64%3B+x64&appVersion=3.2.0&hostName=pc.ctyun.cn&deviceInfo=Win32`;

    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
    });

    const json = (await res.json()) as { code: number; msg?: string };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '绑定设备失败');
    }
    return true;
  }

  /**
   * 7. 拉取云电脑列表 (优先官方标准 /api/desktop/client/list)
   */
  public async getDesktopList(): Promise<Desktop[]> {
    try {
      const listUrl = `${CtYunClient.BASE_URL}/api/desktop/client/list`;
      const res = await fetch(listUrl, {
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
        if (json.code === 0 && json.data?.desktopList) {
          return json.data.desktopList.map((item: any) => ({
            desktopId: String(item.desktopId || item.objId),
            desktopName: item.desktopName || '天翼云电脑',
            desktopCode: item.desktopCode || '',
            useStatusText: item.useStatusText || '运行中',
            imageName: item.imageName || '',
            flavorName: item.flavorName || item.prodGroupName || '',
          }));
        }
      }
    } catch {}

    const res = await fetch(`${CtYunClient.BASE_URL}/api/desktop/client/pageDesktop`, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        getCnt: 20,
        desktopTypes: ['1', '2001', '2002', '2003'],
        sortType: 'createTimeV1',
      }),
    });

    const json = (await res.json()) as {
      code: number;
      msg?: string;
      data: { desktopList: Desktop[] };
    };
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '获取云电脑列表失败');
    }
    return json.data?.desktopList || [];
  }

  /**
   * 8. 获取云电脑连接信息 (WebSocket host & 证书凭证)
   * 完全对齐官方进入云电脑标准：调用 /api/desktop/client/connect 并在网关下发会话注册
   */
  public async connectDesktop(desktopId: string): Promise<DesktopInfo> {
    const formData = new URLSearchParams();
    formData.append('objId', desktopId);
    formData.append('objType', '0');
    formData.append('osType', '15');
    formData.append('deviceId', CtYunClient.DEVICE_TYPE);
    formData.append('vdCommand', '');
    formData.append('ipAddress', '');
    formData.append('macAddress', '');
    formData.append('deviceCode', this.deviceCode);
    formData.append('deviceName', 'Chrome浏览器');
    formData.append('deviceType', CtYunClient.DEVICE_TYPE);
    formData.append('deviceModel', 'Windows NT 10.0; Win64; x64');
    formData.append('appVersion', '3.2.0');
    formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
    formData.append('clientVersion', CtYunClient.VERSION);
    formData.append('specifiedCertCategory', '1');

    try {
      const res = await fetch(`${CtYunClient.BASE_URL}/api/desktop/client/connect`, {
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

    // 若 connect 遇冷备用快速通道
    const statusUrl = `${CtYunClient.BASE_URL}/api/desktop/client/status?desktopId=${desktopId}&specifiedCertCategory=1`;
    const sRes = await fetch(statusUrl, { headers: this.getHeaders() });
    const sJson = (await sRes.json()) as { code: number; msg?: string; data?: { desktopInfo: DesktopInfo } };
    if (sJson.code === 0 && sJson.data?.desktopInfo?.clinkLvsOutHost) {
      return sJson.data.desktopInfo;
    }

    throw new Error(sJson.msg || '获取连接信息失败');
  }

  /**
   * 8.0 模拟官方上报活动事件与桌面进入事件 (推进「登录AI云电脑」任务)
   */
  public async operateDesktop(
    desktopId: string,
    operation: 'on' | 'shutdown' | 'reset',
  ): Promise<string> {
    const typeMap: Record<'on' | 'shutdown' | 'reset', number> = { on: 1, shutdown: 2, reset: 3 };
    const opType = typeMap[operation] || 1;
    const formData = new URLSearchParams();
    formData.append('desktopId', desktopId);
    formData.append('operationType', String(opType));

    const res = await fetch(`${CtYunClient.BASE_URL}/api/desktop/client/operate`, {
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
        on: '开机指令已下发',
        shutdown: '关机指令已下发',
        reset: '重启指令已下发',
      };
      return opNames[operation];
    }
    throw new Error(json.msg || `操作失败 (Code: ${json.code})`);
  }
}
