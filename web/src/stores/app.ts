import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { toast } from 'vue-sonner';
import { confirmDelete } from '@/shared/ui/confirm';

export interface Desktop {
  desktopId: string;
  desktopName: string;
  desktopCode: string;
  useStatusText: string;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';
  lastHeartbeat?: string;
}

export interface Account {
  name: string;
  user: string;
  deviceCode: string;
  status: 'idle' | 'login_needed' | 'need_sms' | 'online' | 'error';
  lastError?: string;
  autoSign?: boolean;
  lastSignDate?: string;
  taskConfig?: {
    enabled?: boolean;
    scheduleTime?: string;
    autoSign?: boolean;
    autoReportActivity?: boolean;
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
      const res = await fetch('/api/auth/status');
      const json = await res.json();
      if (json.success) {
        needAuth.value = Boolean(json.data.needAuth);
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
    adminToken.value = '';
    localStorage.removeItem('ctyun_admin_token');
    disconnectWebSocket();
    toast.info('已退出登录');
  }

  // 3. 业务数据状态
  const accounts = ref<Account[]>([]);
  const keepAliveSeconds = ref(60);
  const logs = ref<LogItem[]>([]);
  const autoScroll = ref(true);

  const totalAccounts = computed(() => accounts.value.length);
  const totalDesktops = computed(() =>
    accounts.value.reduce((acc, a) => acc + (a.desktops?.length || 0), 0),
  );
  const onlineDesktops = computed(() =>
    accounts.value.reduce(
      (acc, a) => acc + (a.desktops?.filter((d) => d.status === 'connected')?.length || 0),
      0,
    ),
  );

  async function fetchStatus() {
    if (needAuth.value && !adminToken.value) return;
    try {
      const res = await fetch('/api/status', { headers: getHeaders() });
      if (res.status === 401) {
        adminLogout();
        return;
      }
      const json = await res.json();
      if (json.success) {
        accounts.value = json.data.accounts || [];
        keepAliveSeconds.value = json.data.keepAliveSeconds || 60;
      }
    } catch (err) {
      console.error('获取状态失败', err);
    }
  }

  const isWsConnected = ref(false);
  let wsClient: WebSocket | null = null;
  let wsReconnectTimer: NodeJS.Timeout | null = null;

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
            keepAliveSeconds.value = msg.data.keepAliveSeconds || 60;
          } else if (msg.type === 'init_logs') {
            logs.value = (msg.logs || []).slice(-200);
          } else if (msg.type === 'log') {
            const incoming: LogItem = msg.log;
            const last = logs.value[logs.value.length - 1];
            if (last && (last.id === incoming.id || (last.message === incoming.message && last.level === incoming.level))) {
              last.count = incoming.count || (last.count || 1) + 1;
              last.time = incoming.time;
            } else {
              logs.value.push(incoming);
              if (logs.value.length > 200) {
                logs.value.splice(0, logs.value.length - 200);
              }
            }
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

  // 4. 账号添加与登录 (官方原生图形验证码直连呈现)
  const showModal = ref(false);
  const modalStep = ref<'login' | 'sms'>('login');
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

  function openAddModal(accName?: string, userPhone?: string) {
    modalStep.value = 'login';
    formUser.value = userPhone || '';
    formName.value = accName || '';
    formPassword.value = '';
    formCaptcha.value = '';
    captchaImgUrl.value = '';
    modalError.value = '';
    smsSentSuccess.value = false;
    smsVerificationCode.value = '';
    smsCaptchaCode.value = '';
    showModal.value = true;
    refreshLoginCaptcha();
  }

  async function refreshLoginCaptcha() {
    const userPhone = formUser.value.trim() || '13800138000';
    const name = formName.value.trim() || userPhone;
    captchaLoading.value = true;
    formCaptcha.value = ''; // 刷新验证码清空旧输入
    try {
      const res = await fetch(
        `/api/account/captcha?accountName=${encodeURIComponent(name)}&user=${encodeURIComponent(
          userPhone,
        )}&_t=${Date.now()}`,
        { headers: getHeaders() },
      );
      const json = await res.json();
      if (json.success && json.data) {
        captchaImgUrl.value = json.data.image;
      }
    } catch {
      captchaImgUrl.value = `/api/account/captcha?accountName=${encodeURIComponent(
        name,
      )}&user=${encodeURIComponent(userPhone)}&_t=${Date.now()}`;
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
      const res = await fetch('/api/account/login', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          accountName: name,
          user: formUser.value.trim(),
          password: formPassword.value,
          captchaCode: formCaptcha.value.trim(),
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
    smsCaptchaImgUrl.value = `/api/account/sms-captcha?accountName=${encodeURIComponent(
      name,
    )}&_t=${Date.now()}`;
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
      const res = await fetch('/api/account/send-sms', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          accountName: name,
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
      const res = await fetch('/api/account/bind-device', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          accountName: name,
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

  async function accountAction(accountName: string, action: 'start' | 'stop' | 'delete') {
    if (action === 'delete') {
      const confirmed = await confirmDelete(`账号 [${accountName}]`, '删除后将移除所有已配置的保活与云电脑实例信息。');
      if (!confirmed) return;
    }
    try {
      const res = await fetch('/api/account/action', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ accountName, action }),
      });
      const data = await res.json();
      if (!data.success) {
        toast.error(data.msg || '操作失败');
      } else {
        if (action === 'delete') toast.success(`账号 [${accountName}] 已删除`);
        else if (action === 'start') toast.success(`账号 [${accountName}] 保活已启动`);
        else toast.info(`账号 [${accountName}] 保活已停止`);
      }
      fetchStatus();
    } catch (err: any) {
      toast.error(err.message || '网络请求错误');
    }
  }

  async function triggerAll(action: 'start' | 'stop') {
    for (const a of accounts.value) {
      await accountAction(a.name, action);
    }
    toast.success(action === 'start' ? '已向所有账号下发保活启动指令' : '已停止所有账号保活');
  }

  // 5. 策略设置弹窗
  const showPolicyModal = ref(false);
  const policyAccount = ref('');
  const policyTaskEnabled = ref(true);
  const policyScheduleTime = ref('08:00');
  const policyAutoSign = ref(true);
  const policyLoginDesktop = ref(true);
  const policyAiChat = ref(true);
  const policyRedeemEnabled = ref(false);
  const policyScheduleType = ref('monthly_last_day');
  const policyMonthlyDay = ref(28);
  const policyIntervalDays = ref(30);
  const policySpecificDate = ref('');
  const policyTargetDesktop = ref('');
  const policyDesktops = ref<Desktop[]>([]);
  const policyTargetProdId = ref<number | ''>('');
  const policyRewards = ref<
    Array<{
      prodId: number;
      prodName: string;
      costPoints: number;
      prodType: string;
      description: string;
    }>
  >([]);
  const policyLoading = ref(false);

  async function openPolicyModal(account: Account) {
    policyAccount.value = account.name;
    const t = (account as any).taskConfig || {};
    policyTaskEnabled.value = t.enabled !== undefined ? t.enabled : (account.autoSign ?? true);
    policyScheduleTime.value = t.scheduleTime || '08:00';
    policyAutoSign.value = t.autoSign !== undefined ? t.autoSign : (account.autoSign ?? true);
    policyLoginDesktop.value = t.loginDesktop !== undefined ? t.loginDesktop : true;
    policyAiChat.value = t.aiChat !== undefined ? t.aiChat : true;

    const r = (account.redeemConfig as any) || {};
    policyRedeemEnabled.value = Boolean(r.enabled);
    policyScheduleType.value = r.scheduleType || 'monthly_last_day';
    policyMonthlyDay.value = r.monthlyDay || 28;
    policyIntervalDays.value = r.intervalDays || 30;
    policySpecificDate.value = r.specificDate || '';
    policyTargetDesktop.value = r.targetDesktopId || '';
    policyTargetProdId.value = r.targetProdId || '';
    policyDesktops.value = account.desktops || [];
    showPolicyModal.value = true;

    // 动态拉取天翼云积分商城真实可兑换商品列表
    try {
      const res = await fetch(`/api/account/rewards?user=${encodeURIComponent(account.user || account.name)}`, {
        headers: getHeaders(),
      });
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        policyRewards.value = json.data;
      }
    } catch {}
  }

  async function savePolicy() {
    policyLoading.value = true;
    const selectedProd = policyRewards.value.find((p) => p.prodId === policyTargetProdId.value);
    try {
      if (policyRedeemEnabled.value && !selectedProd) {
        throw new Error('未获取到官方商品数据，暂不能启用自动兑换');
      }
      const res = await fetch('/api/account/policy', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          accountName: policyAccount.value,
          autoSign: policyTaskEnabled.value && policyAutoSign.value,
          taskConfig: {
            enabled: policyTaskEnabled.value,
            scheduleTime: policyScheduleTime.value || '08:00',
            autoSign: policyAutoSign.value,
            loginDesktop: policyLoginDesktop.value,
            aiChat: policyAiChat.value,
          },
          redeemConfig: {
            enabled: policyRedeemEnabled.value,
            scheduleType: policyScheduleType.value,
            monthlyDay: Number(policyMonthlyDay.value),
            intervalDays: Number(policyIntervalDays.value),
            specificDate: policySpecificDate.value,
            targetDesktopId: policyTargetDesktop.value,
            targetProdId: Number(policyTargetProdId.value),
             costPoints: selectedProd?.costPoints,
             prodType: selectedProd?.prodType,
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

  async function manualRunTasks(accountName: string) {
    try {
      const res = await fetch('/api/account/task/run', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ accountName }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success(json.msg || '每日任务执行成功');
      } else {
        toast.error(json.msg || '任务执行失败');
      }
      fetchStatus();
    } catch (e: any) {
      toast.error(e.message || '任务请求异常');
    }
  }

  async function manualSignIn(accountName: string) {
    try {
      const res = await fetch('/api/account/sign', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ accountName }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success(json.msg || '签到打卡成功');
      } else {
        toast.error(json.msg || '签到失败');
      }
      fetchStatus();
    } catch (e: any) {
      toast.error(e.message || '签到请求异常');
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
      const res = await fetch('/api/account/redeem', {
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
    keepAliveSeconds,
    logs,
    autoScroll,
    totalAccounts,
    totalDesktops,
    onlineDesktops,
    showModal,
    modalStep,
    formUser,
    formName,
    formPassword,
    formCaptcha,
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
    openAddModal,
    refreshLoginCaptcha,
    submitLogin,
    refreshSmsCaptcha,
    sendSms,
    submitBindDevice,
    accountAction,
    renameAccount: async (oldName: string, newName: string) => {
      const res = await fetch('/api/account/rename', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ oldName, newName }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.msg || '修改备注失败');
      toast.success(`账号备注已修改为 [${newName}]`);
      fetchStatus();
    },
    fetchPointsAndTasks: async (accountUserOrName: string) => {
      const res = await fetch(`/api/account/points?user=${encodeURIComponent(accountUserOrName)}`, {
        headers: getHeaders(),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.msg || '获取积分详情失败');
      return json.data;
    },
    triggerAll,
    connectWebSocket,
    disconnectWebSocket,
    isWsConnected,
    showPolicyModal,
    policyAccount,
    policyTaskEnabled,
    policyScheduleTime,
    policyAutoSign,
    policyLoginDesktop,
    policyAiChat,
    policyRedeemEnabled,
    policyScheduleType,
    policyMonthlyDay,
    policyIntervalDays,
    policySpecificDate,
    policyTargetDesktop,
    policyDesktops,
    policyTargetProdId,
    policyRewards,
    policyLoading,
    openPolicyModal,
    savePolicy,
    manualRunTasks,
    manualSignIn,
    manualRedeem,
    operateDesktopPower: async (
      accountName: string,
      desktopId: string,
      operation: 'on' | 'shutdown' | 'reset',
    ) => {
      try {
        const res = await fetch('/api/account/desktop/operate', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ accountName, desktopId, operation }),
        });
        const json = await res.json();
        if (json.success) {
          toast.success(json.msg || '操作指令已执行');
          fetchStatus();
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
        const res = await fetch('/api/account/redeem', {
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
    async clearLogs() {
      logs.value = [];
      try {
        await fetch('/api/logs/clear', {
          method: 'POST',
          headers: getHeaders(),
        });
      } catch {}
    },
  };
});
