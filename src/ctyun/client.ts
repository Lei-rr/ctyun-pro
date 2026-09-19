import { Protocol } from '../clink/protocol.js';
import { EncryptedSession } from './encrypted-session.js';
import { safeFetch , errorText } from '../infra/http.js';

export interface ChallengeData {
  challengeId: string;
  challengeCode: string;
  effectiveSeconds?: number;
}

export interface LoginInfo {
  userAccount: string;
  bondedDevice: boolean;
  secretKey: string;
  userId: number;
  tenantId: number;
  userName: string;
  userEid?: string;
  mobilephone?: string;
  email?: string;
  token?: string;
  [key: string]: unknown;
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
  /** 官方内网地址 (优先用于构建 clink 通道 servername) */
  internalIp?: string;
  internalPort?: string;
  /** 官方主/备接入集群与备用节点列表 */
  connectMaster?: number;
  connectUrl?: string[];
  backupurl?: string[];
  /** 官方云端拉起重试标记 */
  goingRetry?: boolean;
  preemption?: boolean;
  [key: string]: unknown;
}

/** 官方默认 clink 网关 (与 pc.ctyun.cn getWSHost 对齐) */
export const DEFAULT_CLINK_WS_HOST = 'wss://deskmsgz.ctyun.cn:9011/clinkProxy';

export interface Desktop {
  desktopId: string;
  desktopName: string;
  desktopCode: string;
  useStatusText: string;
  useStatus?: number | string;
  desktopInfo?: DesktopInfo;
  imageName?: string;
  flavorName?: string;
  objType?: number; // 0: 普通单机, 1: 政企桌面池, 2: 抢占式
  objId?: string;
  poolId?: string;
  isPool?: boolean;
  /** 官方多线路接入配置 */
  connectMaster?: number;
  connectUrl?: string[];
  backupurl?: string[];
  name?: string;
  computerName?: string;
  [key: string]: unknown;
}

/** 将官方 desktopState 归一化为运行/关机/休眠/过渡/异常五态 */
export function normalizeDesktopState(state?: string): 'running' | 'stopped' | 'suspended' | 'transition' | 'error' | 'unknown' {
  const s = String(state || '').toUpperCase();
  switch (s) {
    case 'ACTIVE':
      return 'running';
    case 'SHUTOFF':
      return 'stopped';
    case 'SUSPENED':
    case 'SUSPENDED':
      return 'suspended';
    case 'TASKRUNING':
    case 'PREEMPTION':
    case 'DEFAULT':
      return 'transition';
    case 'ERROR':
    case 'DELETE':
      return 'error';
    default:
      return 'unknown';
  }
}

/**
 * useStatusText 语义归一化 (服务端下发中文文案)
 * 判定顺序: 休眠/关机 → 离线运行 → 否定词 → 运行/使用
 */
export function normalizeUseStatusText(text?: string): 'running' | 'stopped' | 'suspended' | 'unknown' {
  const t = String(text || '').trim();
  if (!t) return 'unknown';
  // 1. 先判定停止/休眠类关键词 (优先级最高，避免被"未"误伤)
  if (t.includes('休眠') || t.includes('睡眠') || t.includes('挂起')) return 'suspended';
  if (t.includes('关机') || t.includes('停止')) return 'stopped';
  // 2. 官方"离线运行"属运行态 (先于否定词判定)
  if (t.includes('离线运行')) return 'running';
  // 3. 否定词兜底: "未使用"/"未运行" 等不得判定为运行态
  if (t.includes('未')) return 'unknown';
  // 4. 运行/使用
  if (t.includes('运行') || t.includes('使用')) return 'running';
  return 'unknown';
}

export interface DesktopStateInfo {
  objType: number;
  objId: string;
  desktopId: number | string;
  desktopState?: string;
  runningTask?: any;
  runningTaskName?: string | null;
  useStatus?: string | number;
  useStatusText?: string;
  useStatusColor?: string;
}

export interface RawDesktopItem {
  desktopId?: string | number;
  objId?: string | number;
  poolId?: string | number;
  desktopName?: string;
  poolName?: string;
  desktopCode?: string;
  useStatusText?: string;
  useStatus?: number | string;
  imageName?: string;
  flavorName?: string;
  prodGroupName?: string;
  objType?: number;
  /** 官方多线路容灾配置 */
  connectMaster?: number;
  connectUrl?: string[];
  backupurl?: string[];
  [key: string]: unknown;
}

/** 兑换统计查询条目 (对齐 listOrderInstStatisticsV2 入参) */
export interface OrderStatisticsQuery {
  prodIds: number[];
  calendarType?: string;
  totalCalendarType?: string;
  calendarCnt?: string;
  totalCalendarCntDimension?: string;
}

export class CtYunClient {
  public static readonly VERSION = '204000100';
  public static readonly DEVICE_TYPE = '60';
  public static readonly BASE_URL = 'https://desk.ctyun.cn:8810';
  public readonly baseUrl = CtYunClient.BASE_URL;

  private deviceCode: string;
  public loginInfo: LoginInfo | null = null;
  /** 最近一次成功命中的接入线路 (官方 connectUrl/backupurl 容灾) */
  public activeApiBase = CtYunClient.BASE_URL;
  /** 官方请求体 AES-CBC 加密会话 (negotiationEncKey 协商) */
  private encryptedSession = new EncryptedSession();

  private static requestIdCounter = 0;

  public static getNextRequestId(): string {
    return (Date.now() + (++CtYunClient.requestIdCounter)).toString();
  }

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
      'ctg-appmodel': '2',
      'ctg-softwarecode': 'web_client',
      Referer: 'https://pc.ctyun.cn/',
    };

    if (this.loginInfo) {
      const timestamp = Date.now().toString();
      const requestId = CtYunClient.getNextRequestId();
      headers['ctg-userid'] = this.loginInfo.userId.toString();
      headers['ctg-tenantid'] = this.loginInfo.tenantId.toString();
      headers['ctg-timestamp'] = timestamp;
      headers['ctg-requestid'] = requestId;

      // 官方标准签名规范: generatorSignJS({ deviceType, requestId, tenantId, timestamp, userId, version, secretKey }).toUpperCase()
      const signStr = `${CtYunClient.DEVICE_TYPE}${requestId}${this.loginInfo.tenantId}${timestamp}${this.loginInfo.userId}${CtYunClient.VERSION}${this.loginInfo.secretKey}`;
      headers['ctg-signaturestr'] = Protocol.md5(signStr).toUpperCase();

      if (this.loginInfo.token) {
        headers['Cookie'] = `token=${this.loginInfo.token}`;
      }
    }

    return headers;
  }

  /**
   * 官方加密链路惰性协商 (仅在服务端开启 bodyMsgEType 时生效)
   */
  private async ensureNegotiation(): Promise<void> {
    if (this.encryptedSession.enabled) return;
    await this.encryptedSession.negotiate(
      CtYunClient.BASE_URL,
      () => this.getHeaders(),
      (url, init) => safeFetch(url, init as RequestInit & { timeoutMs?: number }),
    );
  }

  /**
   * 统一 API 请求: 自动完成密钥协商、请求体加密与响应体解密
   * 严格对齐官方 Request 拦截器行为
   */
  public async requestApi<T = unknown>(
    path: string,
    init: RequestInit & { jsonBody?: unknown; formBody?: Record<string, string>; baseUrl?: string } = {},
  ): Promise<T> {
    const { jsonBody, formBody, baseUrl, ...rest } = init;
    await this.ensureNegotiation();

    const headers: Record<string, string> = {
      ...this.getHeaders(),
      ...((rest.headers as Record<string, string>) || {}),
    };
    this.encryptedSession.applyHeaders(headers);

    let body = rest.body as string | undefined;
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = this.encryptedSession.encryptBody(jsonBody);
    } else if (formBody !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = this.encryptedSession.encryptForm(formBody);
    }

    // 官方规范: GET 请求的查询参数整体加密为 eUrlParams
    const [pathname, query] = path.split('?');
    const finalPath = query
      ? `${pathname}${this.encryptedSession.encryptQuery(query)}`
      : path;

    const res = await safeFetch(`${baseUrl || this.activeApiBase}${finalPath}`, {
      ...rest,
      headers,
      body,
    });
    const json = (await res.json()) as T;
    return this.encryptedSession.decryptResponse<T>(json);
  }

  /**
   * 发起二进制资源请求 (图形验证码等)，GET 同样应用 eUrlParams 加密
   */
  private async requestBinary(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    await this.ensureNegotiation();
    const merged = this.encryptedSession.applyHeaders({ ...this.getHeaders(), ...headers });
    const [pathname, query] = path.split('?');
    const finalPath = query ? `${pathname}${this.encryptedSession.encryptQuery(query)}` : path;
    return safeFetch(`${this.activeApiBase}${finalPath}`, { headers: merged });
  }

  /**
   * 1. 获取安全挑战数据
   */
  public async getChallengeData(): Promise<ChallengeData> {
    const json = await this.requestApi<{ code: number; msg?: string; data: ChallengeData }>(
      '/api/auth/client/genChallengeData',
      { method: 'POST', jsonBody: {} },
    );
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
    const res = await this.requestBinary(
      `/api/auth/client/captcha?height=36&width=85&userInfo=${encodeURIComponent(userPhone)}&mode=auto&_t=${timestamp}`,
    );
    if (!res.ok) {
      throw new Error(`获取图形验证码失败: HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * 3. 提交登录
   * 对齐官方行为：首次提交不传 captchaCode，仅在服务端返回 51040/51030/51031 时才需要携带
   */
  public async login(
    userPhone: string,
    passwordPlain: string,
    challenge: ChallengeData,
    captchaCode?: string,
  ): Promise<LoginInfo> {
    const pwdSha = Protocol.sha256(passwordPlain);
    const passwordHashed = Protocol.sha256(passwordPlain + challenge.challengeCode);
    const sha256Password = Protocol.sha256(pwdSha + challenge.challengeCode);

    const formData = new URLSearchParams();
    formData.append('userAccount', userPhone);
    formData.append('password', passwordHashed);
    formData.append('sha256Password', sha256Password);
    formData.append('challengeId', challenge.challengeId);
    if (captchaCode && captchaCode.trim()) {
      formData.append('captchaCode', captchaCode.trim());
    }
    formData.append('deviceCode', this.deviceCode);
    formData.append('deviceName', 'Chrome浏览器');
    formData.append('deviceType', CtYunClient.DEVICE_TYPE);
    formData.append('deviceModel', 'Windows NT 10.0; Win64; x64');
    formData.append('appVersion', '4.0.1');
    formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
    formData.append('clientVersion', CtYunClient.VERSION);

    const json = await this.requestApi<{ code: number; msg?: string; data: LoginInfo }>(
      '/api/auth/client/login',
      { method: 'POST', formBody: Object.fromEntries(formData.entries()) },
    );
    if (json.code !== 0 && json.code !== 200) {
      const err = new Error(json.msg || '登录失败') as Error & { code?: number; needCaptcha?: boolean };
      err.code = json.code;
      // 51040: NEED_CAPTCHA, 51030: INVALID_CAPTCHA, 51031: EXPIRE_CAPTCHA
      if ([51040, 51030, 51031].includes(json.code)) {
        err.needCaptcha = true;
      }
      throw err;
    }

    this.loginInfo = json.data;
    return json.data;
  }

  /**
   * 3.1 获取扫码登录二维码数据 (对齐官方自研二维码接口)
   */
  public async genQrCode(): Promise<{ qrCodeId: string; qrUrl: string }> {
    const json = await this.requestApi<{
      code: number;
      msg?: string;
      data?: {
        qrCodeId: string;
        qrCodeEndpoint?: string | null;
        serverHost?: string;
      };
    }>('/api/auth/client/qrCode/genData', { method: 'POST', formBody: {} });
    if (json.code !== 0 || !json.data?.qrCodeId) {
      throw new Error(json.msg || '获取二维码失败');
    }
    const qrCodeId = json.data.qrCodeId;
    let qrUrl = '';
    if (json.data.qrCodeEndpoint) {
      const endpoint = json.data.qrCodeEndpoint;
      const sep = endpoint.includes('?') ? '&' : '?';
      qrUrl = `${endpoint}${sep}qrCodeId=${encodeURIComponent(qrCodeId)}&loginMode=1`;
    } else {
      qrUrl = `https://desk.ctyun.cn/selforder/#/login-confirm?qrCodeId=${encodeURIComponent(qrCodeId)}&loginMode=1`;
    }
    return { qrCodeId, qrUrl };
  }

  /**
   * 3.2 轮询扫码状态
   */
  public async getQrCodeStatus(qrCodeId: string): Promise<{
    codeStatus: 'created' | 'scaned' | 'expire' | 'authorize';
    loginToken?: string;
  }> {
    const json = await this.requestApi<{
      code: number;
      msg?: string;
      data?: {
        codeId: string;
        codeStatus: 'created' | 'scaned' | 'expire' | 'authorize';
        loginToken?: string;
      };
    }>(`/api/auth/client/qrCode/getStatus?qrCodeId=${encodeURIComponent(qrCodeId)}`, { method: 'GET' });
    if (json.code !== 0 || !json.data) {
      throw new Error(json.msg || '查询扫码状态失败');
    }
    return {
      codeStatus: json.data.codeStatus,
      loginToken: json.data.loginToken || undefined,
    };
  }

  /**
   * 3.3 使用扫码授权后的 loginToken 换取正式登录态
   */
  public async loginByToken(accessToken: string): Promise<LoginInfo> {
    const json = await this.requestApi<{ code: number; msg?: string; data: LoginInfo }>(
      '/api/auth/client/tokenLogin',
      {
        method: 'POST',
        jsonBody: {
          accessToken,
          osType: 'Windows',
          deviceModel: 'Windows NT 10.0; Win64; x64',
          appVersion: '4.0.1',
          deviceCode: this.deviceCode,
          deviceName: 'Chrome浏览器',
          deviceType: CtYunClient.DEVICE_TYPE,
          sysVersion: 'Windows NT 10.0; Win64; x64',
          clientVersion: CtYunClient.VERSION,
        },
      },
    );
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '扫码登录验证失败');
    }
    this.loginInfo = json.data;
    return json.data;
  }

  /**
   * 4. 获取绑定设备短信图形验证码
   */
  public async getSmsCodeCaptcha(): Promise<{ image: Buffer; captchaKey: string }> {
    const timestamp = Date.now();
    const res = await this.requestBinary(
      `/api/auth/client/validateCode/captcha?width=120&height=40&_t=${timestamp}`,
    );
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
    let url = `/api/cdserv/client/device/getSmsCode?mobilePhone=${encodeURIComponent(
      userPhone,
    )}&captchaCode=${encodeURIComponent(captchaCode)}`;
    if (captchaCodeKey) {
      url += `&captchaCodeKey=${encodeURIComponent(captchaCodeKey)}`;
    }
    await this.ensureNegotiation();
    const headers = this.encryptedSession.applyHeaders({ ...this.getHeaders() });
    const res = await safeFetch(`${CtYunClient.BASE_URL}${url}`, { headers });
    const smsKey = res.headers.get('ctg-sms-key') || res.headers.get('CTG-SMS-KEY') || '';
    const json = this.encryptedSession.decryptResponse(
      (await res.json()) as { code: number; msg?: string },
    );
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
    formData.append('appVersion', '4.0.1');
    formData.append('hostName', 'pc.ctyun.cn');
    formData.append('deviceInfo', 'Win32');

    const json = await this.requestApi<{ code: number; msg?: string }>(
      '/api/cdserv/client/device/binding',
      { method: 'POST', formBody: Object.fromEntries(formData.entries()) },
    );
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
    desktopList?: RawDesktopItem[];
    desktopPoolList?: RawDesktopItem[];
    preemptionDesktopList?: RawDesktopItem[];
    sortList?: RawDesktopItem[];
  }): Desktop[] {
    const results: Desktop[] = [];

    // 官方 sortList 排序索引 (objType:0 普通机 / 1 桌面池 / 2 抢占式)
    const sortOrder = Array.isArray(data.sortList)
      ? data.sortList.map((s) => `${s.objType ?? 0}:${s.objId ?? s.desktopId ?? ''}`)
      : [];

    const sortResults = (list: Desktop[]): Desktop[] => {
      if (sortOrder.length === 0) return list;
      return [...list].sort((a, b) => {
        const keyA = `${a.objType ?? 0}:${a.objId ?? a.desktopId ?? ''}`;
        const keyB = `${b.objType ?? 0}:${b.objId ?? b.desktopId ?? ''}`;
        const idxA = sortOrder.indexOf(keyA);
        const idxB = sortOrder.indexOf(keyB);
        if (idxA === -1 && idxB === -1) return 0;
        if (idxA === -1) return 1;
        if (idxB === -1) return -1;
        return idxA - idxB;
      });
    };

    // 1. 普通单机 (公众版 / 个人独立分配机 / 精英版 / 尊享版)
    if (Array.isArray(data.desktopList)) {
      for (const item of data.desktopList) {
        results.push({
          desktopId: String(item.desktopId || item.objId),
          desktopName: item.desktopName || '天翼云电脑',
          desktopCode: item.desktopCode || '',
          useStatusText: String(item.useStatusText || item.useStatus || '运行中'),
          useStatus: item.useStatus,
          imageName: item.imageName || '',
          flavorName: item.flavorName || item.prodGroupName || '',
          objType: item.objType ?? 0,
          objId: String(item.objId || item.desktopId),
          isPool: false,
          // 官方多线路容灾字段
          connectMaster: Number(item.connectMaster ?? 0),
          connectUrl: Array.isArray(item.connectUrl) ? item.connectUrl : [],
          backupurl: Array.isArray(item.backupurl) ? item.backupurl : [],
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
          useStatusText: String(item.useStatusText || item.useStatus || '运行中'),
          useStatus: item.useStatus,
          imageName: item.imageName || '',
          flavorName: item.flavorName || item.prodGroupName || '政企版',
          objType: item.objType ?? 1,
          objId: poolId,
          poolId,
          isPool: true,
          connectMaster: Number(item.connectMaster ?? 0),
          connectUrl: Array.isArray(item.connectUrl) ? item.connectUrl : [],
          backupurl: Array.isArray(item.backupurl) ? item.backupurl : [],
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
          useStatusText: String(item.useStatusText || item.useStatus || '运行中'),
          useStatus: item.useStatus,
          imageName: item.imageName || '',
          flavorName: item.flavorName || item.prodGroupName || '',
          objType: item.objType ?? 2,
          objId,
          isPool: false,
          connectMaster: Number(item.connectMaster ?? 0),
          connectUrl: Array.isArray(item.connectUrl) ? item.connectUrl : [],
          backupurl: Array.isArray(item.backupurl) ? item.backupurl : [],
        });
      }
    }

    return sortResults(results);
  }

  /**
   * 7. 分批补拉缺失的桌面详情 (对齐官方 listDesktopByIds，每批最多 30 个对象)
   */
  private async fetchDesktopsByIds(objIds: string[]): Promise<Desktop[]> {
    if (!objIds.length) return [];
    const results: Desktop[] = [];
    for (let i = 0; i < objIds.length; i += 30) {
      const batch = objIds.slice(i, i + 30);
      try {
        const json = await this.requestApi<{
          code: number;
          data?: {
            desktopList?: any[];
            desktopPoolList?: any[];
            preemptionDesktopList?: any[];
          };
        }>('/api/desktop/client/listDesktopByIds', { method: 'POST', jsonBody: { objIds: batch } });
        if (json.code === 0 && json.data) {
          results.push(...CtYunClient.parseDesktopItems(json.data));
        }
      } catch {}
    }
    return results;
  }

  /**
   * 7. 拉取云电脑列表 (优先官方标准 /api/desktop/client/list，备用 /api/desktop/client/pageDesktop)
   * 对齐官方逻辑：读取 sortList 并按 objType 合并；当 sortList 长度大于 getCnt 时用 listDesktopByIds 分批补拉
   */
  public async getDesktopList(): Promise<Desktop[]> {
    try {
      {
        const json = await this.requestApi<{
          code: number;
          msg?: string;
          data: {
            desktopList?: any[];
            desktopPoolList?: any[];
            preemptionDesktopList?: any[];
            sortList?: any[];
          };
        }>('/api/desktop/client/list', { method: 'GET' });
        if (json.code === 0 && json.data) {
          const list = CtYunClient.parseDesktopItems(json.data);
          // 官方分页补齐：sortList 比已返回列表长时，用 listDesktopByIds 补拉缺失桌面
          const sortList = Array.isArray(json.data.sortList) ? json.data.sortList : [];
          if (sortList.length > list.length) {
            const known = new Set(list.map((d) => `${d.objType ?? 0}:${d.objId ?? d.desktopId ?? ''}`));
            const missing = sortList
              .filter((s) => !known.has(`${s.objType ?? 0}:${s.objId ?? s.desktopId ?? ''}`))
              .map((s) => String(s.objId ?? s.desktopId ?? ''))
              .filter(Boolean);
            if (missing.length > 0) {
              const extra = await this.fetchDesktopsByIds(missing);
              if (extra.length > 0) {
                const merged = [...list];
                const mergedKeys = new Set(known);
                for (const d of extra) {
                  const key = `${d.objType ?? 0}:${d.objId ?? d.desktopId ?? ''}`;
                  if (!mergedKeys.has(key)) {
                    merged.push(d);
                    mergedKeys.add(key);
                  }
                }
                // 按官方 sortList 顺序重排
                const order = sortList.map((s) => `${s.objType ?? 0}:${s.objId ?? s.desktopId ?? ''}`);
                merged.sort((a, b) => {
                  const ia = order.indexOf(`${a.objType ?? 0}:${a.objId ?? a.desktopId ?? ''}`);
                  const ib = order.indexOf(`${b.objType ?? 0}:${b.objId ?? b.desktopId ?? ''}`);
                  if (ia === -1 && ib === -1) return 0;
                  if (ia === -1) return 1;
                  if (ib === -1) return -1;
                  return ia - ib;
                });
                return merged;
              }
            }
          }
          if (list.length > 0) return list;
        }
      }
    } catch {}

    // 对齐官方 pageDesktop: getCnt=20, desktopTypes=['1','2001','2002','2003'], sortType=createTimeV1
    const json = await this.requestApi<{
      code: number;
      msg?: string;
      data: {
        desktopList?: any[];
        desktopPoolList?: any[];
        preemptionDesktopList?: any[];
        sortList?: any[];
      };
    }>('/api/desktop/client/pageDesktop', {
      method: 'POST',
      jsonBody: {
        getCnt: 20,
        desktopTypes: ['1', '2001', '2002', '2003'],
        sortType: 'createTimeV1',
      },
    });
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.msg || '获取云电脑列表失败');
    }
    const data = json.data || {};
    let list = CtYunClient.parseDesktopItems(data);
    // 官方分页补齐：sortList 长于当前列表时用 listDesktopByIds 补拉
    const sortList = Array.isArray(data.sortList) ? data.sortList : [];
    if (sortList.length > list.length) {
      const known = new Set(list.map((d) => `${d.objType ?? 0}:${d.objId ?? d.desktopId ?? ''}`));
      const missing = sortList
        .filter((s) => !known.has(`${s.objType ?? 0}:${s.objId ?? s.desktopId ?? ''}`))
        .map((s) => String(s.objId ?? s.desktopId ?? ''))
        .filter(Boolean);
      if (missing.length > 0) {
        const extra = await this.fetchDesktopsByIds(missing);
        if (extra.length > 0) list = [...list, ...extra.filter((d) => !known.has(`${d.objType ?? 0}:${d.objId ?? d.desktopId ?? ''}`))];
      }
    }
    return list;
  }

  /**
   * 7.1 获取云电脑实时运行状态 (对齐官方 api/desktop/client/state 轻量级毫秒级接口)
   */
  public async getDesktopState(desktopId: string, objType = 0): Promise<DesktopStateInfo | null> {
    try {
      const json = await this.requestApi<{ code: number; data?: DesktopStateInfo[] }>(
        '/api/desktop/client/state',
        { method: 'POST', jsonBody: [{ objId: String(desktopId), objType }] },
      );
      if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
        return json.data[0];
      }
    } catch {}
    return null;
  }

  /**
   * 7.2 修改云电脑官方昵称/备注 (对齐官方 api/selforder/order/desktop/modifyDesktopNickName)
   */
  public async modifyDesktopNickName(desktopId: string, nickName: string): Promise<boolean> {
    const json = await this.requestApi<{ code: number; msg?: string; data?: boolean }>(
      '/api/selforder/order/desktop/modifyDesktopNickName',
      { method: 'POST', jsonBody: { desktopId: String(desktopId), nickName } },
    );
    if (json.code === 0 && json.data) {
      return true;
    }
    throw new Error(json.msg || '修改云电脑名称失败');
  }

  /**
   * 8. 获取云电脑连接信息 (WebSocket host & 证书凭证)
   * 完全对齐官方进入云电脑标准：支持普通机直连与政企桌面池动态分派连接
   * @param forceFresh 是否强制向官方调度中心申请全新 Ticket (跳过 status 缓存)
   */
  public async connectDesktop(desktopIdOrObj: string | Desktop, objType = 0, forceFresh = false): Promise<DesktopInfo> {
    const desktopId = typeof desktopIdOrObj === 'string' ? desktopIdOrObj : desktopIdOrObj.desktopId;
    const targetObjType = typeof desktopIdOrObj === 'string' ? objType : (desktopIdOrObj.objType ?? objType);
    const targetObjId = typeof desktopIdOrObj === 'string' ? desktopId : (desktopIdOrObj.objId || desktopIdOrObj.poolId || desktopId);

    // 0. 解析官方多线路接入配置 (connectMaster/connectUrl/backupurl)
    const connectMaster = typeof desktopIdOrObj === 'object' ? Number(desktopIdOrObj.connectMaster ?? 0) : 0;
    const connectUrls = typeof desktopIdOrObj === 'object' ? (desktopIdOrObj.connectUrl || []) : [];
    const backupUrls = typeof desktopIdOrObj === 'object' ? (desktopIdOrObj.backupurl || []) : [];

    // 1. 优先通过官方 status 接口获取 (仅在非强制刷新模式且为普通单机时使用)
    if (!forceFresh && targetObjType === 0) {
      try {
        const statusPath = `${connectMaster === 1 ? '/api/desktop/client/statusMaster' : '/api/desktop/client/status'}?desktopId=${desktopId}&specifiedCertCategory=1`;
        const sJson = await this.requestApi<{ code: number; msg?: string; data?: { desktopInfo: DesktopInfo } }>(
          statusPath,
          { method: 'GET' },
        );
        if (sJson.code === 0 && sJson.data?.desktopInfo?.clinkLvsOutHost) {
          return sJson.data.desktopInfo;
        }
      } catch {}
    }

    // 2. 核心调度: 通过 connect 接口动态申请全新 Ticket 与双向证书
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
    formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
    formData.append('appVersion', '4.0.1');
    formData.append('hostName', 'pc.ctyun.cn');
    formData.append('hardwareFeatureCode', this.deviceCode);
    formData.append('desktopId', String(desktopId));
    formData.append('clientVersion', CtYunClient.VERSION);
    formData.append('specifiedCertCategory', '1');

    // 官方线路候选：主集群 → connectUrl 集群列表 → backupurl 备用节点
    const connectPath = connectMaster === 1 ? '/api/desktop/client/connectMaster' : '/api/desktop/client/connect';
    const apiBases: string[] = [this.activeApiBase];
    for (const u of [CtYunClient.BASE_URL, ...connectUrls, ...backupUrls]) {
      if (u && !apiBases.includes(u)) apiBases.push(u);
    }

    let lastError = '';
    for (const base of apiBases) {
      try {
        const json = await this.requestApi<{
          code: number;
          msg?: string;
          data?: { desktopInfo?: DesktopInfo };
        }>(connectPath, {
          method: 'POST',
          formBody: Object.fromEntries(formData.entries()),
          baseUrl: base,
        });
        if (json.code === 0 && json.data?.desktopInfo?.clinkLvsOutHost) {
          const info = json.data.desktopInfo;
          // 记录本次命中的接入线路，供后续 API 请求复用
          this.activeApiBase = base;
          info.connectMaster = connectMaster;
          info.connectUrl = connectUrls;
          info.backupurl = backupUrls;
          return info;
        }
        lastError = json.msg || `官方接口返回异常 (Code ${json.code})`;
      } catch (e) {
        lastError = errorText(e);
      }
    }

    throw new Error(lastError || '获取连接信息失败');
  }

  /**
   * 8.0 模拟官方上报活动事件与桌面进入/电源管理事件
   * 支持 on (开机, 1), awake (唤醒, 18), shutdown (关机, 2), reset (重启, 3), restore (恢复/开机重置, 6), force_off (强制关机, 4), force_reboot (强制重启, 5)
   */
  public async operateDesktop(
    desktopId: string,
    operation: 'on' | 'awake' | 'shutdown' | 'reset' | 'restore' | 'off' | 'stop' | 'reboot' | 'restart' | 'force_off' | 'force_reboot',
    objType = 0,
  ): Promise<string> {
    const typeMap: Record<string, number> = {
      on: 1,
      start: 1,
      shutdown: 2,
      off: 2,
      stop: 2,
      poweroff: 2,
      reset: 3,
      reboot: 3,
      restart: 3,
      force_off: 4,
      force_reboot: 5,
      restore: 6,
      awake: 18,
      wake: 18,
      wakeup: 18,
      resume: 18,
    };
    const opType = typeMap[operation] ?? 1;
    const formData = new URLSearchParams();
    formData.append('desktopId', desktopId);
    formData.append('objId', desktopId);
    formData.append('objType', String(objType));
    formData.append('operationType', String(opType));

    const json = await this.requestApi<{ code: number; msg?: string }>(
      '/api/desktop/client/operate',
      { method: 'POST', formBody: Object.fromEntries(formData.entries()) },
    );
    if (json.code === 0) {
      const opNames: Record<number, string> = {
        1: '开机指令已下发，正在启动...',
        18: '唤醒指令已下发，正在从休眠中唤醒...',
        2: '关机指令已下发...',
        3: '重启指令已下发，正在重启...',
        4: '强制关机指令已下发...',
        5: '强制重启指令已下发，正在重启...',
        6: '恢复指令已下发...',
      };
      return opNames[opType] || '电源控制指令已下发';
    }
    // 特殊容错：若提示“只有已关机状态允许进行开机操作”或状态不符，平滑判定
    if (
      (opType === 1 || opType === 18) &&
      (json.code === 30010 || json.msg?.includes('已关机状态') || json.msg?.includes('已运行') || json.msg?.includes('已经处于'))
    ) {
      return '云电脑已在运行中或处于可用状态';
    }
    throw new Error(json.msg || `操作失败 (Code: ${json.code})`);
  }

  /**
   * 8.1 官方标准: 会话释放与退出连接上报 (对齐 api/desktop/client/quitConnect)
   */
  public async quitConnect(desktopId: string, objType = 0): Promise<boolean> {
    try {
      const formData = new URLSearchParams();
      formData.append('objId', desktopId);
      formData.append('objType', String(objType));
      formData.append('osType', '15');
      formData.append('deviceId', CtYunClient.DEVICE_TYPE);
      formData.append('deviceCode', this.deviceCode);
      formData.append('deviceName', 'Chrome浏览器');
      formData.append('sysVersion', 'Windows NT 10.0; Win64; x64');
      formData.append('appVersion', '4.0.1');
      formData.append('hostName', 'pc.ctyun.cn');
      formData.append('ipAddress', '');
      formData.append('macAddress', '');
      formData.append('hardwareFeatureCode', this.deviceCode);

      const json = await this.requestApi<{ code: number; msg?: string }>(
        '/api/desktop/client/quitConnect',
        { method: 'POST', formBody: Object.fromEntries(formData.entries()) },
      );
      return json.code === 0 || json.code === 200;
    } catch {
      return false;
    }
  }

  /**
   * 生成单点登录/免密直通 Token
   */
  public async genLoginToken(effectiveSeconds = 300): Promise<string> {
    if (!this.loginInfo) {
      throw new Error('账号尚未登录，无法生成登录 Token');
    }
    const json = await this.requestApi<{ code: number; msg?: string; data?: { token: string } }>(
      '/api/auth/client/genLoginToken',
      { method: 'POST', jsonBody: { authAppModel: 34, effectiveSeconds } },
    );
    if (json.code === 0 && json.data?.token) {
      return json.data.token;
    }
    throw new Error(json.msg || `获取免密 Token 失败 (Code: ${json.code})`);
  }

  /** 官方积分中心 (selforder SPA) 的接口根地址 (该 SPA 不启用请求体加密) */
  public static readonly SELFORDER_URL = 'https://desk.ctyun.cn/selforder';

  /**
   * 同步用户基础信息 (对齐官方积分中心 /selforder/api/auth/client/syncUserInfo)
   * 返回 realNameStatus (3 = 实名认证通过) 等字段
   */
  public async syncUserInfo(): Promise<{ realNameStatus?: number; canBindMobilephone?: boolean; [key: string]: unknown }> {
    const res = await safeFetch(`${CtYunClient.SELFORDER_URL}/api/auth/client/syncUserInfo`, {
      headers: this.getHeaders(),
    });
    const json = (await res.json()) as { code: number; msg?: string; data?: Record<string, unknown> };
    if (json.code === 0 && json.data) {
      return json.data;
    }
    throw new Error(json.msg || `同步用户信息失败 (Code: ${json.code})`);
  }

  /**
   * 批量查询积分商品兑换统计 (对齐官方 /selforder/api/desktop-admin/order/mgr/listOrderInstStatisticsV2)
   * 返回 { currentUser: { prodId: { count } }, totalUser: { prodId: { count } } }
   */
  public async listOrderInstStatistics(
    items: OrderStatisticsQuery[],
  ): Promise<{ currentUser: Record<string, { count: number }>; totalUser: Record<string, { count: number }> }> {
    const res = await safeFetch(
      `${CtYunClient.SELFORDER_URL}/api/desktop-admin/order/mgr/listOrderInstStatisticsV2`,
      {
        method: 'POST',
        headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
      },
    );
    const json = (await res.json()) as {
      code: number;
      msg?: string;
      data?: {
        currentUser?: Record<string, { count: number }>;
        totalUser?: Record<string, { count: number }>;
      };
    };
    if (json.code === 0 && json.data) {
      return {
        currentUser: json.data.currentUser || {},
        totalUser: json.data.totalUser || {},
      };
    }
    throw new Error(json.msg || `查询兑换统计失败 (Code: ${json.code})`);
  }
}
