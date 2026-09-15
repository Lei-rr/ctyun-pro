import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { toast } from 'vue-sonner';
import { confirmDelete } from '@/shared/ui/confirm';
import { router } from '@/router';

export interface Desktop {
  id: string;
  desktopCode: string;
  desktopName: string;
  useStatusText: string;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'stopped';
  lastHeartbeat?: string;
  watchdog?: {
    active: boolean;
    currentIntervalSec: number;
    nextProbeSec: number;
    failRounds: number;
  };
  yieldStatus?: {
    yielding: boolean;
    remainingSeconds: number;
    reason?: string;
  };
}

export interface Account {
  name: string;
  user: string;
  deviceCode: string;
  status: 'idle' | 'login_needed' | 'need_sms' | 'online' | 'error';
  autoStart?: boolean;
  lastError?: string;
  taskConfig?: {
    enabled?: boolean;
    scheduleTime?: string;
    aiChat?: boolean;
    lastRunDate?: string;
  };
  redeemConfig?: {
    enabled?: boolean;
    targetProdId?: number;
    costPoints?: number;
    targetDesktopId?: string;
    scheduleType?: string;
    monthlyDay?: number;
    intervalDays?: number;
    specificDate?: string;
    lastRedeemDate?: string;
  };
  todayPoints?: number;
  desktops: Desktop[];
}

export interface LogItem {
  id: number;
  time: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  count?: number;
}

export const useAppStore = defineStore('app', () => {
  // 1. 主题黑白切换
  const isDark = ref(localStorage.getItem('theme') !== 'light');
  function toggleTheme() {
    isDark.value = !isDark.value;
    if (isDark.value) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }
  if (isDark.value) document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');

  // 2. 鉴权管理
  const needAuth = ref(false);
  const adminToken = ref(localStorage.getItem('ctyun_admin_token') || '');
  const isAuthenticated = computed(() => !needAuth.value || Boolean(adminToken.value));
  const adminPasswordInput = ref('');
  const loginLoading = ref(false);
  const loginError = ref('');

  function getHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminToken.value) {
      h['x-admin-token'] = adminToken.value;
    }
    return h;
  }

  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status', { headers: getHeaders() });
      const json = await res.json();
      if (json.success) {
        needAuth.value = Boolean(json.data.needAuth);
        if (needAuth.value && json.data.authenticated === false && adminToken.value) {
          adminToken.value = '';
          localStorage.removeItem('ctyun_admin_token');
        }
      }
    } catch {}
  }

  async function adminLogin(): Promise<boolean> {
    if (!adminPasswordInput.value) return false;
    loginLoading.value = true;
    loginError.value = '';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPasswordInput.value }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.msg || '密码错误');
      adminToken.value = json.token;
      localStorage.setItem('ctyun_admin_token', json.token);
      // 显式写入客户端同源 Cookie，保障新标签页直连与子页面始终能获取同源凭证 (30天长效)
      try {
        document.cookie = `ctyun_admin_token=${encodeURIComponent(json.token)}; path=/; max-age=${30 * 24 * 3600}; SameSite=Lax`;
      } catch (e) {}
      adminPasswordInput.value = '';
      toast.success('登录成功');
      connectWebSocket();
      await fetchStatus();
      return true;
    } catch (err: any) {
      loginError.value = err.message;
      toast.error(err.message || '登录失败');
      return false;
    } finally {
      loginLoading.value = false;
    }
  }

  function adminLogout() {
    const prevToken = adminToken.value;
    try {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(prevToken ? { 'x-admin-token': prevToken } : {}),
        },
      }).catch(() => {});
    } catch {}
    adminToken.value = '';
    localStorage.removeItem('ctyun_admin_token');
    try {
      document.cookie = 'ctyun_admin_token=; path=/; max-age=0; SameSite=Lax';
    } catch (e) {}
    disconnectWebSocket();
    accounts.value = [];
    toast.info('已退出登录或登录已过期，请重新登录');
    if (router.currentRoute.value.path !== '/login') {
      router.replace('/login');
    }
  }

  // 3. 业务数据状态
  const accounts = ref<Account[]>([]);
  const webhookUrl = ref('');
  const logs = ref<LogItem[]>([]);
  const autoScroll = ref(true);

  const totalAccounts = computed(() => accounts.value.length);
  const totalDesktops = computed(() =>
    accounts.value.reduce((acc, a) => acc + (a.desktops?.length || 0), 0),
  );
  const onlineDesktops = computed(() =>
    accounts.value.reduce(
      (acc, a) =>
        acc +
        (a.desktops?.filter(
          (d) => d.status === 'connected',
        )?.length || 0),
      0,
    ),
  );

  async function fetchStatus() {
    if (needAuth.value && !adminToken.value) {
      if (router.currentRoute.value.path !== '/login') {
        router.replace('/login');
      }
      return;
    }
    try {
      const res = await fetch('/api/status', { headers: getHeaders() });
      if (res.status === 401) {
        adminLogout();
        return;
      }
      const json = await res.json();
      if (json.success) {
        accounts.value = json.data.accounts || [];
        webhookUrl.value = json.data.webhookUrl || '';
      }
    } catch (err) {
      console.error('获取状态失败', err);
    }
  }

  const isWsConnected = ref(false);
  let wsClient: WebSocket | null = null;
  let wsReconnectTimer: NodeJS.Timeout | null = null;

  function initLogs(newLogs: LogItem[]) {
    logs.value = (newLogs || []).slice(-1000);
  }

  // 智能折叠日志插入：在当前末尾连续心跳波次（Block）内寻找同款心跳折叠，遇到业务日志立即打断
  function appendLog(incoming: LogItem) {
    const isHeartbeat = incoming.message && incoming.message.includes('发送客户端活跃心跳');
    let found = false;
    if (isHeartbeat) {
      for (let i = logs.value.length - 1; i >= 0; i--) {
        const item = logs.value[i];
        const itemIsHeartbeat = item.message && item.message.includes('发送客户端活跃心跳');
        if (!itemIsHeartbeat) {
          // 遇到业务/报警日志，停止回溯
          break;
        }
        if (
          item.id === incoming.id ||
          (item.message === incoming.message && item.level === incoming.level)
        ) {
          const [matched] = logs.value.splice(i, 1);
          matched.count = incoming.count || (matched.count || 1) + 1;
          matched.time = incoming.time;
          logs.value.push(matched);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      logs.value.push(incoming);
      if (logs.value.length > 1000) {
        logs.value.splice(0, logs.value.length - 1000);
      }
    }
  }

  function connectWebSocket() {
    if (needAuth.value && !adminToken.value) return;
    if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const tokenQuery = adminToken.value ? `?token=${encodeURIComponent(adminToken.value)}` : '';
    const wsUrl = `${protocol}//${host}/ws${tokenQuery}`;

    try {
      wsClient = new WebSocket(wsUrl);

      wsClient.onopen = () => {
        isWsConnected.value = true;
        if (wsReconnectTimer) {
          clearTimeout(wsReconnectTimer);
          wsReconnectTimer = null;
        }
      };

      wsClient.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'status') {
            accounts.value = msg.data.accounts || [];
            if (msg.data.webhookUrl !== undefined) webhookUrl.value = msg.data.webhookUrl || '';
          } else if (msg.type === 'init_logs') {
            initLogs(msg.logs);
          } else if (msg.type === 'log') {
            appendLog(msg.log);
          }
        } catch {}
      };

      wsClient.onclose = () => {
        isWsConnected.value = false;
        wsClient = null;
        if (!wsReconnectTimer) {
          wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            connectWebSocket();
          }, 3000);
        }
      };

      wsClient.onerror = () => {
        try {
          wsClient?.close();
        } catch {}
      };
    } catch {
      isWsConnected.value = false;
    }
  }

  function disconnectWebSocket() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (wsClient) {
      try {
        wsClient.close();
      } catch {}
      wsClient = null;
    }
    isWsConnected.value = false;
  }

  // 4. 账号添加与登录 (官方原生图形验证码直连呈现与扫码登录)
  const showModal = ref(false);
  const modalStep = ref<'login' | 'sms'>('login');
  const loginMode = ref<'qrcode' | 'password'>('qrcode');
  const qrCodeId = ref('');
  const qrImage = ref('');
  const qrStatus = ref<'loading' | 'created' | 'scaned' | 'expire' | 'authorize'>('loading');
  const qrLoading = ref(false);
  let qrPollTimer: any = null;

  const formUser = ref('');
  const formName = ref('');
  const formPassword = ref('');
  const formCaptcha = ref('');
  const captchaImgUrl = ref('');
  const modalLoading = ref(false);
  const captchaLoading = ref(false);
  const modalError = ref('');

  const smsCaptchaImgUrl = ref('');
  const smsCaptchaCode = ref('');
  const smsVerificationCode = ref('');
  const smsSentSuccess = ref(false);

  function stopQrPolling() {
    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }
  }

  watch(showModal, (val) => {
    if (!val) stopQrPolling();
  });

  async function initQrLogin() {
    stopQrPolling();
    qrLoading.value = true;
    qrStatus.value = 'loading';
    qrImage.value = '';
    modalError.value = '';
    try {
      const res = await fetch('/api/profiles/qrcode/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken.value ? { 'x-admin-token': adminToken.value } : {}),
        },
        body: JSON.stringify({ accountName: formName.value.trim() }),
      });
      const json = await res.json();
      if (!json.success || !json.data?.qrCodeId) {
        throw new Error(json.msg || '获取二维码失败');
      }
      qrCodeId.value = json.data.qrCodeId;
      qrImage.value = json.data.qrImage;
      qrStatus.value = 'created';
      startQrPolling();
    } catch (e: any) {
      modalError.value = e.message || '生成二维码失败';
      qrStatus.value = 'expire';
    } finally {
      qrLoading.value = false;
    }
  }

  function startQrPolling() {
    stopQrPolling();
    qrPollTimer = setInterval(async () => {
      if (!showModal.value || loginMode.value !== 'qrcode' || !qrCodeId.value) {
        stopQrPolling();
        return;
      }
      try {
        const url = `/api/profiles/qrcode/status?qrCodeId=${encodeURIComponent(
          qrCodeId.value,
        )}&accountName=${encodeURIComponent(formName.value.trim())}`;
        const res = await fetch(url, {
          headers: {
            ...(adminToken.value ? { 'x-admin-token': adminToken.value } : {}),
          },
        });
        const json = await res.json();
        if (json.success) {
          if (json.codeStatus === 'scaned') {
            qrStatus.value = 'scaned';
          } else if (json.codeStatus === 'expire') {
            qrStatus.value = 'expire';
            stopQrPolling();
          } else if (json.codeStatus === 'authorize') {
            qrStatus.value = 'authorize';
            stopQrPolling();
            toast.success(`[${json.accountName || '新账号'}] 扫码登录成功！已自动开启保活`);
            showModal.value = false;
            await fetchStatus();
          }
        }
      } catch {}
    }, 1500);
  }

  const currentChallenge = ref<{ challengeId: string; challengeCode: string } | null>(null);

  function switchLoginMode(mode: 'qrcode' | 'password') {
    loginMode.value = mode;
    modalError.value = '';
    if (mode === 'qrcode') {
      if (!qrImage.value || qrStatus.value === 'expire') {
        initQrLogin();
      } else {
        startQrPolling();
      }
    } else {
      stopQrPolling();
      if (!captchaImgUrl.value && formUser.value.trim().length >= 11) {
        refreshLoginCaptcha();
      }
    }
  }

  let lastFetchedPhone = '';
  function onPhoneInput() {
    const clean = formUser.value.trim();
    if (clean.length === 11) {
      if (clean !== lastFetchedPhone) {
        lastFetchedPhone = clean;
        refreshLoginCaptcha(clean);
      }
    } else if (clean.length < 11 && lastFetchedPhone) {
      lastFetchedPhone = '';
      captchaImgUrl.value = '';
      formCaptcha.value = '';
      currentChallenge.value = null;
    }
  }

  function openAddModal(accName?: string, userPhone?: string) {
    modalStep.value = 'login';
    loginMode.value = 'qrcode';
    formUser.value = userPhone || '';
    formName.value = accName || '';
    formPassword.value = '';
    formCaptcha.value = '';
    captchaImgUrl.value = '';
    currentChallenge.value = null;
    modalError.value = '';
    lastFetchedPhone = '';
    smsSentSuccess.value = false;
    smsVerificationCode.value = '';
    smsCaptchaCode.value = '';
    showModal.value = true;
    initQrLogin();
    if (formUser.value.trim().length >= 11) {
      lastFetchedPhone = formUser.value.trim();
      refreshLoginCaptcha();
    }
  }

  async function refreshLoginCaptcha(forceUser?: string) {
    const userPhone = (forceUser !== undefined ? forceUser : formUser.value).trim();
    if (!userPhone) {
      captchaImgUrl.value = '';
      currentChallenge.value = null;
      return;
    }
    const name = formName.value.trim() || userPhone;
    captchaLoading.value = true;
    formCaptcha.value = ''; // 刷新验证码清空旧输入
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(name)}/captcha?user=${encodeURIComponent(userPhone)}&_t=${Date.now()}`,
        { headers: getHeaders() },
      );
      const json = await res.json();
      if (json.success && json.data) {
        captchaImgUrl.value = json.data.image;
        if (json.data.challenge) {
          currentChallenge.value = json.data.challenge;
        }
      }
    } catch {
      captchaImgUrl.value = `/api/profiles/${encodeURIComponent(
        name,
      )}/captcha?user=${encodeURIComponent(userPhone)}&_t=${Date.now()}`;
    } finally {
      captchaLoading.value = false;
    }
  }

  async function submitLogin() {
      if (!formUser.value || !formCaptcha.value) {
        modalError.value = '请填写手机号和图形验证码';
        return;
      }
      modalLoading.value = true;
      modalError.value = '';
      const name = formName.value.trim() || formUser.value.trim();

      try {
        const res = await fetch(`/api/profiles/${encodeURIComponent(name)}/login`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            name,
            user: formUser.value.trim(),
            password: formPassword.value,
            captchaCode: formCaptcha.value.trim(),
            challenge: currentChallenge.value,
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.msg || '登录失败');

        if (data.needSms) {
          modalStep.value = 'sms';
          refreshSmsCaptcha();
        } else {
          showModal.value = false;
          toast.success(`账号 [${name}] 登录并保活成功`);
          fetchStatus();
        }
      } catch (err: any) {
        modalError.value = err.message;
        toast.error(err.message || '登录失败');
        refreshLoginCaptcha();
      } finally {
        modalLoading.value = false;
      }
    }

    function refreshSmsCaptcha() {
      const name = formName.value.trim() || formUser.value.trim();
      smsCaptchaImgUrl.value = `/api/profiles/${encodeURIComponent(
        name,
      )}/sms-captcha?_t=${Date.now()}`;
    }

    async function sendSms() {
      if (!smsCaptchaCode.value) {
        modalError.value = '请输入短信图验字符';
        return;
      }
      modalLoading.value = true;
      modalError.value = '';
      const name = formName.value.trim() || formUser.value.trim();
      try {
        const res = await fetch(`/api/profiles/${encodeURIComponent(name)}/send-sms`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            name,
            user: formUser.value.trim(),
            captchaCode: smsCaptchaCode.value.trim(),
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.msg || '发送短信失败');
        smsSentSuccess.value = true;
        toast.success('短信验证码已成功发送');
      } catch (err: any) {
        modalError.value = err.message;
        toast.error(err.message || '发送短信失败');
        refreshSmsCaptcha();
      } finally {
        modalLoading.value = false;
      }
    }

    async function submitBindDevice() {
      if (!smsVerificationCode.value) {
        modalError.value = '请输入收到的短信验证码';
        return;
      }
      modalLoading.value = true;
      modalError.value = '';
      const name = formName.value.trim() || formUser.value.trim();
      try {
        const res = await fetch(`/api/profiles/${encodeURIComponent(name)}/bind-device`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            name,
            smsCode: smsVerificationCode.value.trim(),
          }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.msg || '绑定失败');
        showModal.value = false;
        toast.success(`新设备已绑定成功，账号 [${name}] 启动保活`);
        fetchStatus();
      } catch (err: any) {
        modalError.value = err.message;
        toast.error(err.message || '绑定失败');
      } finally {
        modalLoading.value = false;
      }
    }

  const accountActionLoading = ref<Record<string, string>>({});
  const batchActionLoading = ref(false);

  async function accountAction(accountName: string, action: 'start' | 'stop' | 'delete') {
    if (action === 'delete') {
      const confirmed = await confirmDelete(`账号 [${accountName}]`, '删除后将移除所有已配置的保活与云电脑实例信息。');
      if (!confirmed) return;
    }

    accountActionLoading.value[accountName] = action;

    // 乐观即时更新前端状态，提升丝滑手感，无需等待网络来回
    const targetAcc = accounts.value.find((a) => a.name === accountName);
    if (targetAcc) {
      if (action === 'start') {
        targetAcc.status = 'online';
      } else if (action === 'stop') {
        targetAcc.status = 'idle';
        if (targetAcc.desktops) {
          for (const d of targetAcc.desktops) {
            d.status = 'stopped';
          }
        }
      }
    }

    try {
      let res: Response;
      if (action === 'delete') {
        res = await fetch(`/api/profiles/${encodeURIComponent(accountName)}`, {
          method: 'DELETE',
          headers: getHeaders(),
        });
      } else if (action === 'start') {
        res = await fetch(`/api/profiles/${encodeURIComponent(accountName)}/start`, {
          method: 'POST',
          headers: getHeaders(),
          body: '{}',
        });
      } else if (action === 'stop') {
        res = await fetch(`/api/profiles/${encodeURIComponent(accountName)}/stop`, {
          method: 'POST',
          headers: getHeaders(),
          body: '{}',
        });
      } else {
        res = await fetch(`/api/profiles/${encodeURIComponent(accountName)}/sync`, {
          method: 'POST',
          headers: getHeaders(),
          body: '{}',
        });
      }
      const data = await res.json();
      if (!data.success) {
        toast.error(data.msg || '操作失败');
      } else {
        if (action === 'delete') toast.success(`账号 [${accountName}] 已删除`);
        else if (action === 'start') toast.success(`账号 [${accountName}] 保活已启动`);
        else toast.info(`账号 [${accountName}] 保活已彻底停止`);
      }
      fetchStatus();
    } catch (err: any) {
      toast.error(err.message || '网络请求错误');
      fetchStatus();
    } finally {
      delete accountActionLoading.value[accountName];
    }
  }

  async function triggerAll(action: 'start' | 'stop') {
    if (batchActionLoading.value) return;
    batchActionLoading.value = true;
    try {
      for (let i = 0; i < accounts.value.length; i++) {
        const a = accounts.value[i];
        if (i > 0) {
          // 仿生错峰调度：账号间间隔 800ms，配合后端并发门禁
          await new Promise((r) => setTimeout(r, 800));
        }
        await accountAction(a.name, action);
      }
      toast.success(action === 'start' ? '已向所有账号下发保活启动指令' : '已停止所有账号保活');
    } finally {
      batchActionLoading.value = false;
    }
  }

  // 5. 策略设置弹窗
  const showPolicyModal = ref(false);
  const policyAccount = ref('');
  const policyTaskEnabled = ref(true);
  const policyRedeemEnabled = ref(false);
  const policyScheduleType = ref('interval_days');
  const policyMonthlyDay = ref(28);
  const policyIntervalDays = ref(4);
  const policySpecificDate = ref('');
  const policyTargetDesktop = ref('');
  const policyDesktops = ref<Desktop[]>([]);
  const policyTargetProdId = ref<number | ''>(17024101);
  const LOCAL_DEFAULT_REWARDS = [
    {
      prodId: 17023101,
      prodName: '8C16G升配包1天',
      costPoints: 500,
      prodType: 'pointstplupgrade',
      description: '可将AI云电脑（公众版、政企版）升配至8C16G，最多支持兑换365天；规格升配、重置均会重启AI云电脑，请注意保存数据',
    },
    {
      prodId: 17023111,
      prodName: '16C32G升配包1天',
      costPoints: 1000,
      prodType: 'pointstplupgrade',
      description: '可将AI云电脑（政企版）升配至16C32G，最多支持兑换365天；规格升配、恢复均会重启AI云电脑，请注意保存数据',
    },
    {
      prodId: 17021101,
      prodName: '天翼AI云手机1个月试用',
      costPoints: 9000,
      prodType: 'pointscomputer',
      description: '权益：天翼AI云手机包月不限时，有效期1个月',
    },
    {
      prodId: 17022101,
      prodName: '游戏AI云电脑包月5小时试用',
      costPoints: 7500,
      prodType: 'pointscomputer',
      description: '权益：游戏AI云电脑包月5小时试用，有效期1个月',
    },
    {
      prodId: 17010101,
      prodName: '专属智库1G存储空间',
      costPoints: 1000,
      prodType: 'cpcai',
      description: '权益：基于当前AI应用中心存储空间，叠加1G存储空间，每月限兑5次',
    },
    {
      prodId: 17020101,
      prodName: 'AI应用中心高级版',
      costPoints: 1000,
      prodType: 'cpcai',
      description: '权益：AI应用中心高级版，支持DeepSeek满血版、专属智库等，有效期1个月',
    },
    {
      prodId: 17024101,
      prodName: '1G数据盘永久扩容',
      costPoints: 1200,
      prodType: 'pointsdiskupgrade',
      description: '兑换后，将自动创建1个新数据盘，该盘仅支持积分扩容，最大不超过500GB',
    },
  ];

  function sortRewardsList(items: any[]) {
    const priorityOrder = [17023101, 17023111, 17021101, 17022101, 17010101, 17020101, 17024101];
    return [...items].sort((a, b) => {
      const idxA = priorityOrder.indexOf(Number(a.prodId));
      const idxB = priorityOrder.indexOf(Number(b.prodId));
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return (Number(a.costPoints) || 0) - (Number(b.costPoints) || 0);
    });
  }

  const policyRewards = ref<
    Array<{
      prodId: number;
      prodName: string;
      costPoints: number;
      prodType: string;
      description: string;
    }>
  >(sortRewardsList(LOCAL_DEFAULT_REWARDS));
  const policyLoading = ref(false);

  const policyRewardsLoading = ref(false);

  async function refreshPolicyRewards() {
    policyRewardsLoading.value = true;
    try {
      const acc = accounts.value.find((a) => a.name === policyAccount.value);
      const res = await fetch(
        `/api/rewards?profileId=${encodeURIComponent(acc?.name || policyAccount.value)}&refresh=1&_t=${Date.now()}`,
        { headers: getHeaders() },
      );
      const json = await res.json();
      if (json.success && Array.isArray(json.data) && json.data.length > 0) {
        policyRewards.value = sortRewardsList(json.data);
        toast.success('已刷新官方商城最新商品');
      } else {
        toast.info('官方暂未更新，保持现有商品目录');
      }
    } catch {
      toast.error('刷新商品目录失败');
    } finally {
      policyRewardsLoading.value = false;
    }
  }

  async function openPolicyModal(account: Account) {
    policyAccount.value = account.name;
    const t = account.taskConfig || {};
    policyTaskEnabled.value = t.enabled !== undefined ? t.enabled : true;

    const r = (account.redeemConfig as any) || {};
    policyRedeemEnabled.value = Boolean(r.enabled);
    policyScheduleType.value = r.scheduleType || 'interval_days';
    policyMonthlyDay.value = r.monthlyDay || 28;
    policyIntervalDays.value = r.intervalDays || 4;
    policySpecificDate.value = r.specificDate || '';
    policyTargetDesktop.value = r.targetDesktopId || '';
    policyTargetProdId.value = r.targetProdId ? Number(r.targetProdId) : 17024101;
    policyDesktops.value = account.desktops || [];
    showPolicyModal.value = true;

    // 弹窗打开时，若尚未加载或商品列表为空，静默拉取服务端持久化的统一商品列表
    if (policyRewards.value.length === 0) {
      try {
        const res = await fetch(`/api/rewards?_t=${Date.now()}`, { headers: getHeaders() });
        const json = await res.json();
        if (json.success && Array.isArray(json.data) && json.data.length > 0) {
          policyRewards.value = sortRewardsList(json.data);
        }
      } catch {}
    }
  }

  async function savePolicy() {
    policyLoading.value = true;
    const selectedProd = policyRewards.value.find((p) => p.prodId === policyTargetProdId.value);
    try {
      if (policyRedeemEnabled.value && !selectedProd) {
        throw new Error('未获取到官方商品数据，暂不能启用自动兑换');
      }
      const res = await fetch(`/api/profiles/${encodeURIComponent(policyAccount.value)}/policy`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          accountName: policyAccount.value,
          taskConfig: {
            enabled: policyTaskEnabled.value,
            aiChat: policyTaskEnabled.value,
          },
          redeemConfig: {
            enabled: policyRedeemEnabled.value,
            scheduleType: policyScheduleType.value,
            monthlyDay: policyMonthlyDay.value,
            intervalDays: policyIntervalDays.value,
            specificDate: policySpecificDate.value,
            targetDesktopId: policyTargetDesktop.value || undefined,
            targetProdId: policyTargetProdId.value || 17024101,
            costPoints: selectedProd?.costPoints || 1200,
            prodType: selectedProd?.prodType || 'pointsdiskupgrade',
            targetReward: selectedProd?.prodName || '1G数据盘永久扩容',
            fallbackDays: 4,
          },
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.msg || '保存失败');
      showPolicyModal.value = false;
      toast.success(`账号 [${policyAccount.value}] 任务与兑换策略已保存`);
      fetchStatus();
    } catch (e: any) {
      toast.error(e.message || '策略保存失败');
    } finally {
      policyLoading.value = false;
    }
  }

  async function manualAiChatTask(accountName: string) {
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(accountName)}/tasks/chat`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ accountName }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success(json.msg || 'AI 对话任务完成');
      } else {
        toast.error(json.msg || 'AI 对话失败');
      }
      fetchStatus();
    } catch (e: any) {
      toast.error(e.message || '请求异常');
    }
  }

  async function manualRedeem(accountName: string) {
    const r = policyRewards.value.find((p) => p.prodId === policyTargetProdId.value);
    const cost = r ? r.costPoints : 500;
    const name = r?.prodName || '官方商品';
    const prodId = policyTargetProdId.value;
    const prodType = r?.prodType;
    const desktopId = policyTargetDesktop.value || undefined;

    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(accountName)}/tasks/redeem`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          accountName,
          prodId,
          costPoints: cost,
          prodType,
          desktopId,
        }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success(json.msg || `成功兑换 [${name}]！`);
      } else {
        toast.error(json.msg || '兑换失败');
      }
      fetchStatus();
    } catch (e: any) {
      toast.error(e.message || '兑换请求异常');
    }
  }

  return {
    isDark,
    toggleTheme,
    needAuth,
    adminToken,
    isAuthenticated,
    adminPasswordInput,
    loginLoading,
    loginError,
    adminLogin,
    adminLogout,
    accounts,
    webhookUrl,
    logs,
    autoScroll,
    totalAccounts,
    totalDesktops,
    onlineDesktops,
    showModal,
    modalStep,
    loginMode,
    qrCodeId,
    qrImage,
    qrStatus,
    qrLoading,
    initQrLogin,
    startQrPolling,
    stopQrPolling,
    switchLoginMode,
    formUser,
    formName,
    formPassword,
    formCaptcha,
    currentChallenge,
    captchaImgUrl,
    modalLoading,
    captchaLoading,
    modalError,
    smsCaptchaImgUrl,
    smsCaptchaCode,
    smsVerificationCode,
    smsSentSuccess,
    fetchStatus,
    checkAuthStatus,
    onPhoneInput,
    openAddModal,
    refreshLoginCaptcha,
    submitLogin,
    refreshSmsCaptcha,
    sendSms,
    submitBindDevice,
    accountAction,
    accountActionLoading,
    batchActionLoading,
    triggerAll,
    renameAccount: async (oldName: string, newName: string) => {
      const res = await fetch(`/api/profiles/${encodeURIComponent(oldName)}/rename`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ oldName, newName }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.msg || '修改备注失败');
      toast.success(`账号备注已修改为 [${newName}]`);
      await fetchStatus();
    },
    renameDesktop: async (desktopCode: string, newName: string) => {
      const res = await fetch(`/api/desktops/${encodeURIComponent(desktopCode)}/rename`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ desktopName: newName }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.msg || '修改云电脑名称失败');
      toast.success(`云电脑名称已修改为 [${newName}]`);
      await fetchStatus();
    },
    fetchPointsAndTasks: async (accountUserOrName: string) => {
      const res = await fetch(`/api/profiles/${encodeURIComponent(accountUserOrName)}/tasks`, {
        headers: getHeaders(),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.msg || '获取积分详情失败');
      return json.data;
    },
    connectWebSocket,
    disconnectWebSocket,
    isWsConnected,
    showPolicyModal,
    policyAccount,
    policyTaskEnabled,
    policyRedeemEnabled,
    policyScheduleType,
    policyMonthlyDay,
    policyIntervalDays,
    policySpecificDate,
    policyTargetDesktop,
    policyDesktops,
    policyTargetProdId,
    policyRewards,
    policyRewardsLoading,
    refreshPolicyRewards,
    policyLoading,
    openPolicyModal,
    savePolicy,
    manualAiChatTask,
    manualRedeem,
    operateDesktopPower: async (
      accountName: string,
      desktopCode: string,
      operation: 'on' | 'shutdown' | 'reset',
    ) => {
      try {
        const res = await fetch(`/api/desktops/${encodeURIComponent(desktopCode)}/power`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ action: operation, accountName }),
        });
        const json = await res.json();
        if (json.success) {
          toast.success(json.msg || '操作指令已执行');
          fetchStatus();
          // 若触发了开机，前端启动快速轮询直至状态转为“运行中”
          if (operation === 'on' || operation === 'reset') {
            let polls = 0;
            const pollTimer = setInterval(async () => {
              polls++;
              await fetchStatus();
              const acc = accounts.value.find((a) => a.name === accountName);
              const dt = acc?.desktops.find((d) => d.desktopCode === desktopCode);
              if (dt && (dt.useStatusText === '运行中' || dt.status === 'connected' || polls >= 60)) {
                clearInterval(pollTimer);
              }
            }, 4000);
          }
          return true;
        } else {
          toast.error(json.msg || '操作失败');
          return false;
        }
      } catch (e: any) {
        toast.error(e.message || '操作请求异常');
        return false;
      }
    },
    redeemSpecificProduct: async (
      accountKey: string,
      prodId: number,
      costPoints: number,
      prodType: string,
      desktopId?: string,
    ) => {
      try {
        const res = await fetch(`/api/profiles/${encodeURIComponent(accountKey)}/tasks/redeem`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({
            accountName: accountKey,
            prodId,
            costPoints,
            prodType,
            desktopId,
          }),
        });
        const json = await res.json();
        if (json.success) {
          toast.success(json.msg || '兑换成功！');
          fetchStatus();
          return true;
        } else {
          toast.error(json.msg || '兑换失败');
          return false;
        }
      } catch (e: any) {
        toast.error(e.message || '兑换请求异常');
        return false;
      }
    },
    async getDesktopDirectUrl(desktopCode: string): Promise<string | null> {
      try {
        const res = await fetch(`/api/desktops/${encodeURIComponent(desktopCode)}/direct-url`, {
          headers: getHeaders(),
        });
        const json = await res.json();
        if (json.success && json.data?.url) {
          return json.data.url;
        } else {
          toast.error(json.msg || '获取桌面免密直连失败');
          return null;
        }
      } catch (e: any) {
        toast.error(e.message || '获取桌面直连异常');
        return null;
      }
    },
    getHeaders,
    initLogs,
    appendLog,
    async clearLogs() {
      logs.value = [];
      try {
        const res = await fetch('/api/logs/clear', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (json.success) {
          toast.success('实时日志已清空');
        } else {
          toast.info('日志显示已清空');
        }
      } catch (e: any) {
        toast.info('日志显示已清空');
      }
    },
  };
});
