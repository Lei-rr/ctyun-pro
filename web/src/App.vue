<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRoute, useRouter, RouterLink, RouterView } from 'vue-router';
import { useAppStore } from '@/stores/app';
import {
  Monitor,
  Moon,
  Sun,
  Server,
  Terminal,
  LogOut,
  Sliders,
  Settings,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  ChevronDown,
  Settings2,
  Shield,
} from 'lucide-vue-next';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Input } from '@/shared/ui/input';
import { Switch } from '@/shared/ui/switch';
import { AppDialog } from '@/shared/ui/dialog';
import { AppTooltip, TooltipProvider } from '@/shared/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/shared/ui/dropdown-menu';
import { Toaster } from '@/shared/ui/sonner';
import { ConfirmHost, confirmDialog } from '@/shared/ui/confirm';

declare const __APP_VERSION__: string;
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v1.1.2';
import { toast } from 'vue-sonner';

const store = useAppStore();
const route = useRoute();
const router = useRouter();

async function handleLogout() {
  store.adminLogout();
  router.replace('/login');
}

// 当前移动端导航显示文本
const currentNavTitle = computed(() => {
  if (route.path === '/logs') return '实时日志';
  return '控制台';
});

// 全局设置弹窗
const showSystemModal = ref(false);
const sysKeepAlive = ref(60);
const sysAdminPassword = ref('');
const sysWebhookUrl = ref('');
const sysLoading = ref(false);
const testWebhookLoading = ref(false);

function openConfigModal() {
  sysKeepAlive.value = store.keepAliveSeconds || 60;
  sysAdminPassword.value = '';
  sysWebhookUrl.value = store.webhookUrl || '';
  showSystemModal.value = true;
}

function openSystemModal() {
  openConfigModal();
}

async function handleTestWebhook() {
  const url = sysWebhookUrl.value.trim();
  if (!url) {
    toast.error('请先在输入框中填入 Webhook 地址');
    return;
  }
  testWebhookLoading.value = true;
  try {
    const res = await fetch('/api/config/webhook/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(store.adminToken ? { 'x-admin-token': store.adminToken } : {}),
      },
      body: JSON.stringify({ webhookUrl: url }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.msg || '测试推送失败');
    toast.success(json.msg || '测试消息已成功送达！');
  } catch (e: any) {
    toast.error(e.message || '测试推送失败');
  } finally {
    testWebhookLoading.value = false;
  }
}

async function saveSystemConfig() {
  sysLoading.value = true;
  try {
    const payload: any = {
      keepAliveSeconds: Number(sysKeepAlive.value),
      webhookUrl: sysWebhookUrl.value.trim(),
    };
    if (sysAdminPassword.value.trim()) {
      payload.adminPassword = sysAdminPassword.value.trim();
    }
    const res = await fetch('/api/config/system', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(store.adminToken ? { 'x-admin-token': store.adminToken } : {}),
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.msg || '保存失败');
    showSystemModal.value = false;
    await store.fetchStatus();
    toast.success('系统配置已持久化保存至 data/config.json');
  } catch (e: any) {
    toast.error(e.message || '保存配置失败');
  } finally {
    sysLoading.value = false;
  }
}

async function handleManualRedeemInModal() {
  const confirmed = await confirmDialog({
    title: '确认兑换 8C16G',
    description: `确认立即为账号 [${store.policyAccount}] 执行兑换 8C16G 规格吗？将消耗 300 积分。`,
    confirmText: '立即兑换',
    cancelText: '取消',
    destructive: false,
  });
  if (!confirmed) return;
  await store.manualRedeem(store.policyAccount);
}

let statusTimer: number | undefined;
onMounted(async () => {
  // 路由守卫 router.beforeEach 已经执行过 checkAuthStatus，此处无需重复调用
  if (store.needAuth && !store.isAuthenticated) {
    router.replace('/login');
    return;
  }
  await store.fetchStatus();
  store.connectWebSocket();
  // 30秒兜底心跳轮询
  statusTimer = window.setInterval(() => store.fetchStatus(), 30000);
});

onUnmounted(() => {
  if (statusTimer) window.clearInterval(statusTimer);
});
</script>

<template>
  <TooltipProvider>
    <!-- 独立全屏登录页（无顶栏和底栏） -->
    <div v-if="route.path === '/login'" class="bg-background text-foreground min-h-svh flex flex-col antialiased">
      <RouterView />
      <Toaster position="top-center" :close-button="true" />
    </div>

    <!-- 主控制台布局 (带统一规范的顶栏与页脚) -->
    <div v-else class="bg-background text-foreground relative flex min-h-svh flex-col antialiased selection:bg-muted selection:text-foreground">
      <!-- 顶栏导航 -->
      <header class="bg-background/80 backdrop-blur-md sticky top-0 z-50 w-full border-b border-border/40">
          <div class="mx-auto flex h-14 w-full max-w-6xl min-w-0 items-center gap-2 px-4 sm:h-16 sm:px-6 lg:px-8">
            <!-- Logo 区域 -->
            <RouterLink to="/" class="mr-2 flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight">
              <span class="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md text-sm font-bold shadow-xs">
                C
              </span>
              <span class="hidden sm:inline">CTYUN-PRO</span>
            </RouterLink>

            <!-- 桌面端常驻导航 (舒适大字号 text-[15px]，高度 h-9) -->
            <nav class="hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto lg:flex">
              <Button variant="ghost" as-child size="sm" class="h-9 shrink-0 px-3 text-[15px] cursor-pointer">
                <RouterLink to="/" :class="route.path === '/' && 'bg-accent text-accent-foreground font-medium'">
                  控制台
                </RouterLink>
              </Button>
              <Button variant="ghost" as-child size="sm" class="h-9 shrink-0 px-3 text-[15px] cursor-pointer">
                <RouterLink to="/logs" :class="route.path === '/logs' && 'bg-accent text-accent-foreground font-medium'">
                  实时日志
                </RouterLink>
              </Button>
            </nav>

            <!-- 手机端折叠导航 (解决文字溢出，当前模块下拉切换) -->
            <div class="min-w-0 flex-1 lg:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="sm" class="h-9 max-w-full gap-1 px-2 text-[15px] cursor-pointer">
                    <span class="truncate font-medium">{{ currentNavTitle }}</span>
                    <ChevronDown class="size-4 shrink-0 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" class="w-44">
                  <DropdownMenuItem as-child>
                    <RouterLink to="/" class="w-full cursor-pointer" :class="route.path === '/' && 'bg-accent font-medium'">
                      控制台
                    </RouterLink>
                  </DropdownMenuItem>
                  <DropdownMenuItem as-child>
                    <RouterLink to="/logs" class="w-full cursor-pointer" :class="route.path === '/logs' && 'bg-accent font-medium'">
                      实时日志
                    </RouterLink>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <!-- 右侧工具栏 -->
            <div class="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
              <!-- 主题切换 -->
              <AppTooltip :content="store.isDark ? '切换为浅色模式' : '切换为深色模式'">
                <Button variant="ghost" size="icon" class="size-9 cursor-pointer" @click="store.toggleTheme()">
                  <Sun v-if="store.isDark" class="size-4" />
                  <Moon v-else class="size-4" />
                </Button>
              </AppTooltip>

              <!-- 更多设置下拉菜单 -->
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon" class="size-9 cursor-pointer" title="更多功能">
                    <Settings2 class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-44">
                  <DropdownMenuItem @select="openConfigModal" class="gap-2 cursor-pointer">
                    <Settings class="size-4" />
                    <span>系统设置</span>
                  </DropdownMenuItem>
                  <template v-if="store.needAuth">
                    <DropdownMenuSeparator />
                    <DropdownMenuItem @select="handleLogout" class="gap-2 text-destructive focus:text-destructive cursor-pointer">
                      <LogOut class="size-4" />
                      <span>退出登录</span>
                    </DropdownMenuItem>
                  </template>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <!-- 主体内容 (严格采用 max-w-6xl 舒展留白 py-6~8) -->
        <main class="flex flex-1 flex-col">
          <div class="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            <RouterView v-slot="{ Component, route: currentRoute }">
              <Transition name="page-fade" mode="out-in">
                <component :is="Component" :key="currentRoute.fullPath" />
              </Transition>
            </RouterView>
          </div>
        </main>

        <!-- 页脚：版本号与项目链接 (对齐 dns-pro) -->
        <footer class="mt-auto border-t border-border/40 py-5 text-xs text-muted-foreground">
          <div class="mx-auto flex h-6 w-full max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8 whitespace-nowrap">
            <div class="flex items-center gap-2 overflow-hidden text-ellipsis">
              <span class="font-semibold text-foreground/90">CTYUN-PRO</span>
              <Badge variant="outline" class="h-4.5 px-1.5 text-[10px] font-normal shrink-0 border-border/60">
                {{ appVersion }}
              </Badge>
              <span class="hidden sm:inline text-muted-foreground/70">· 天翼云电脑多账号保活与积分兑换系统</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <AppTooltip content="GitHub 源码仓库">
                <a
                  href="https://github.com/Lei-rr/ctyun-pro"
                  target="_blank"
                  rel="noreferrer"
                  class="p-1.5 rounded-md hover:text-foreground hover:bg-accent transition-colors flex items-center justify-center cursor-pointer"
                >
                  <svg class="size-4 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill-rule="evenodd"
                      clip-rule="evenodd"
                      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                    />
                  </svg>
                </a>
              </AppTooltip>
            </div>
          </div>
        </footer>

      <!-- 弹窗 1: 添加账号/登录 (采用规范的 AppDialog) -->
      <AppDialog
        v-model:open="store.showModal"
        :title="store.modalStep === 'login' ? '添加天翼云账号' : '设备首次绑定短信认证'"
        :description="store.modalStep === 'login' ? '输入账号密码，官方图形验证码看图直填' : '新设备登录需手机短信确认绑定'"
        content-class="sm:max-w-md"
      >
        <div v-if="store.modalError" class="p-2.5 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs">
          {{ store.modalError }}
        </div>

        <!-- 步骤 1: 账号登录表单 (紧凑精致的间距) -->
        <form v-if="store.modalStep === 'login'" @submit.prevent="store.submitLogin()" class="space-y-2.5">
          <div class="space-y-1">
            <label class="text-xs font-medium text-foreground">手机号码</label>
            <Input
              type="text"
              v-model="store.formUser"
              @input="store.onPhoneInput"
              placeholder="天翼云登录手机号"
              required
              class="h-9"
            />
          </div>

          <div class="space-y-1">
            <label class="text-xs font-medium text-foreground">备注名称 (可选)</label>
            <Input
              type="text"
              v-model="store.formName"
              placeholder="默认与手机号相同"
              class="h-9"
            />
          </div>

          <div class="space-y-1">
            <label class="text-xs font-medium text-foreground">登录密码</label>
            <Input
              type="password"
              v-model="store.formPassword"
              placeholder="天翼云密码"
              required
              class="h-9"
            />
          </div>

          <!-- 图形验证码：官方直连看图直填 -->
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <label class="text-xs font-medium text-foreground">图形验证码</label>
              <span class="text-[11px] text-muted-foreground">
                看图直填 (点击图片可换一张)
              </span>
            </div>
            <div class="flex items-center gap-2">
              <Input
                type="text"
                v-model="store.formCaptcha"
                placeholder="输入 4 位字符"
                required
                class="flex-1 h-9 min-w-0 font-medium tracking-wider"
              />
              <div
                @click="store.refreshLoginCaptcha()"
                class="h-9 w-28 rounded-lg bg-muted/60 border border-border flex items-center justify-center cursor-pointer overflow-hidden hover:border-muted-foreground/50 transition-colors shrink-0 select-none p-0.5"
                title="点击换一张验证码"
              >
                <img
                  v-if="store.captchaImgUrl"
                  :src="store.captchaImgUrl"
                  class="h-full w-full object-contain pointer-events-none rounded"
                  alt="图形验证码"
                />
                <span v-else class="text-xs text-muted-foreground flex items-center gap-1">
                  <RefreshCw v-if="store.captchaLoading" class="size-3.5 animate-spin" />
                  <span v-else>点击获取</span>
                </span>
              </div>
            </div>
          </div>

          <div class="pt-1">
            <Button
              type="submit"
              :disabled="store.modalLoading"
              class="w-full h-9 shadow-xs cursor-pointer text-sm"
            >
              {{ store.modalLoading ? '正在登录验证...' : '确认并登录' }}
            </Button>
          </div>
        </form>

        <!-- 步骤 2: 短信验证码表单 -->
        <div v-else class="space-y-3">
          <div class="space-y-1">
            <label class="text-xs font-medium text-foreground">第一步：获取短信图验</label>
            <div class="flex items-center gap-2">
              <Input
                type="text"
                v-model="store.smsCaptchaCode"
                placeholder="输入图验字符"
                class="flex-1 h-9 min-w-0"
              />
              <div
                @click="store.refreshSmsCaptcha()"
                class="h-9 w-28 rounded-lg bg-muted/60 border border-border flex items-center justify-center cursor-pointer overflow-hidden shrink-0 p-0.5"
                title="点击刷新短信图验"
              >
                <img v-if="store.smsCaptchaImgUrl" :src="store.smsCaptchaImgUrl" class="h-full w-full object-contain rounded" />
                <span v-else class="text-xs text-muted-foreground">刷新</span>
              </div>
              <Button
                type="button"
                variant="secondary"
                @click="store.sendSms()"
                :disabled="store.modalLoading"
                class="h-9 text-xs shrink-0 cursor-pointer"
              >
                发送短信
              </Button>
            </div>
            <p v-if="store.smsSentSuccess" class="text-xs text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1">
              <CheckCircle2 class="size-3.5" /> 短信已发出，请注意查收
            </p>
          </div>

          <div class="space-y-1">
            <label class="text-xs font-medium text-foreground">第二步：输入短信验证码</label>
            <Input
              type="text"
              v-model="store.smsVerificationCode"
              placeholder="6位短信验证码"
              class="h-9 font-mono tracking-widest"
            />
          </div>

          <div class="pt-1.5 flex gap-2 w-full">
            <Button
              type="button"
              variant="outline"
              @click="store.modalStep = 'login'"
              class="flex-1 h-9 cursor-pointer"
            >
              返回
            </Button>
            <Button
              type="button"
              @click="store.submitBindDevice()"
              :disabled="store.modalLoading"
              class="flex-1 h-9 shadow-xs cursor-pointer"
            >
              {{ store.modalLoading ? '正在绑定...' : '绑定并保活' }}
            </Button>
          </div>
        </div>
      </AppDialog>

      <!-- 弹窗 2: 自动化策略设置 (采用规范的 AppDialog) -->
      <AppDialog
        v-model:open="store.showPolicyModal"
        title="自动化任务与兑换策略"
        :description="`配置账号 [${store.policyAccount}] 的每日自动任务与积分兑换`"
        content-class="sm:max-w-md"
      >
        <div class="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <!-- 模块 1: 每日定时任务 -->
          <div class="p-4 rounded-xl bg-muted/40 border border-border/40 space-y-3.5">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium text-foreground">每日自动任务</div>
                <div class="text-xs text-muted-foreground">定时自动完成签到、AI 对话与云电脑挂机</div>
              </div>
              <Switch v-model:checked="store.policyTaskEnabled" />
            </div>

            <div v-if="store.policyTaskEnabled" class="pt-3 space-y-3 border-t border-border/40">
              <div class="space-y-1.5">
                <label class="text-xs font-medium text-foreground">每日执行时间</label>
                <Input
                  type="time"
                  v-model="store.policyScheduleTime"
                  class="h-9 font-mono text-xs"
                />
              </div>

              <div class="space-y-2 pt-1 text-xs">
                <div class="flex items-center justify-between py-1">
                  <div>
                    <span class="text-foreground font-medium">登录 AI 云电脑</span>
                    <span class="text-emerald-500 font-medium ml-1.5">+100分</span>
                  </div>
                  <Switch v-model:checked="store.policyLoginDesktop" />
                </div>
                <div class="flex items-center justify-between py-1">
                  <div>
                    <span class="text-foreground font-medium">与 AI 助手对话</span>
                    <span class="text-emerald-500 font-medium ml-1.5">+100分</span>
                  </div>
                  <Switch v-model:checked="store.policyAiChat" />
                </div>
                <div class="flex items-center justify-between py-1">
                  <div>
                    <span class="text-foreground font-medium">使用 1 小时智能补时挂机</span>
                    <span class="text-emerald-500 font-medium ml-1.5">+100分</span>
                  </div>
                  <Switch v-model:checked="store.policyKeepAliveHang" />
                </div>
              </div>
            </div>
          </div>

          <!-- 模块 2: 自动兑换 -->
          <div class="p-4 rounded-xl bg-muted/40 border border-border/40 space-y-3.5">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm font-medium text-foreground">自动兑换商品</div>
                <div class="text-xs text-muted-foreground">周期到达时自动使用积分在官方商城兑换</div>
              </div>
              <Switch v-model:checked="store.policyRedeemEnabled" />
            </div>

            <div v-if="store.policyRedeemEnabled" class="pt-3 space-y-3 border-t border-border/40">
              <div class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <label class="text-xs font-medium text-foreground">目标商品</label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
                    :disabled="store.policyRewardsLoading"
                    @click="store.refreshPolicyRewards()"
                    title="从天翼云官方商城同步最新商品目录"
                  >
                    <RefreshCw class="size-3" :class="{ 'animate-spin': store.policyRewardsLoading }" />
                    <span>刷新商品</span>
                  </Button>
                </div>
                <div class="flex items-center gap-2">
                  <select
                    v-model="store.policyTargetProdId"
                    class="flex-1 h-9 px-3 text-xs rounded-lg bg-background border border-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring min-w-0"
                  >
                    <option
                      v-for="item in store.policyRewards"
                      :key="item.prodId"
                      :value="item.prodId"
                    >
                      {{ item.prodName }} ({{ item.costPoints }} 积分)
                    </option>
                    <option v-if="store.policyRewards.length === 0" value="" disabled>
                      暂无官方商品数据
                    </option>
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    class="h-9 px-2.5 text-xs gap-1 cursor-pointer shrink-0 border-border/60"
                    :disabled="store.policyRewardsLoading"
                    @click="store.refreshPolicyRewards()"
                    title="从天翼云官方商城同步最新商品"
                  >
                    <RefreshCw class="size-3.5" :class="{ 'animate-spin': store.policyRewardsLoading }" />
                    <span>刷新</span>
                  </Button>
                </div>
              </div>

              <div class="space-y-1.5">
                <label class="text-xs font-medium text-foreground">绑定云电脑实例</label>
                <select
                  v-model="store.policyTargetDesktop"
                  class="w-full h-9 px-3 text-xs rounded-lg bg-background border border-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">默认第一台云电脑</option>
                  <option v-for="d in store.policyDesktops" :key="d.desktopId" :value="d.desktopId">
                    {{ d.desktopName || '云电脑' }} ({{ d.desktopCode || d.desktopId }})
                  </option>
                </select>
              </div>

              <div class="space-y-1.5">
                <label class="text-xs font-medium text-foreground">执行周期</label>
                <select
                  v-model="store.policyScheduleType"
                  class="w-full h-9 px-3 text-xs rounded-lg bg-background border border-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="monthly_last_day">月末最后一天 (推荐)</option>
                  <option value="monthly_day">每月固定日期</option>
                  <option value="specific_date">指定具体日期</option>
                  <option value="interval_days">按间隔天数</option>
                  <option value="daily">每日自动执行</option>
                </select>
              </div>

              <!-- 周期参数输入 -->
              <div v-if="store.policyScheduleType === 'monthly_day'" class="space-y-1.5">
                <label class="text-xs font-medium text-foreground">每月执行日 (1~31)</label>
                <Input
                  type="number"
                  v-model="store.policyMonthlyDay"
                  min="1"
                  max="31"
                  class="h-9 text-xs"
                />
              </div>
              <div v-else-if="store.policyScheduleType === 'specific_date'" class="space-y-1.5">
                <label class="text-xs font-medium text-foreground">选择指定日期</label>
                <Input
                  type="date"
                  v-model="store.policySpecificDate"
                  class="h-9 text-xs"
                />
              </div>
              <div v-else-if="store.policyScheduleType === 'interval_days'" class="space-y-1.5">
                <label class="text-xs font-medium text-foreground">间隔天数</label>
                <Input
                  type="number"
                  v-model="store.policyIntervalDays"
                  min="1"
                  max="365"
                  class="h-9 text-xs"
                />
              </div>
            </div>
          </div>
        </div>

        <template #footer>
          <div class="flex items-center justify-end gap-2 w-full">
            <Button variant="outline" class="h-9 cursor-pointer" @click="store.showPolicyModal = false">
              取消
            </Button>
            <Button
              class="h-9 shadow-xs cursor-pointer px-5"
              :disabled="store.policyLoading"
              @click="store.savePolicy"
            >
              {{ store.policyLoading ? '正在保存...' : '保存策略' }}
            </Button>
          </div>
        </template>
      </AppDialog>

      <!-- 弹窗 3: 系统设置 (采用规范的 AppDialog) -->
      <AppDialog
        v-model:open="showSystemModal"
        title="系统设置"
        description="配置项将自动持久化至 data/config.json"
        content-class="sm:max-w-md"
      >
        <form @submit.prevent="saveSystemConfig" class="space-y-4">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">修改管理员口令 (留空则不修改)</label>
            <Input
              type="password"
              v-model="sysAdminPassword"
              placeholder="设置新密码"
              class="h-9"
            />
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">Webhook 推送地址 (支持 Server酱 / Bark / PushPlus / 企微 / 飞书 / 钉钉)</label>
            <div class="flex gap-2">
              <Input
                type="text"
                v-model="sysWebhookUrl"
                placeholder="https://..."
                class="h-9 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                :disabled="testWebhookLoading"
                @click="handleTestWebhook"
                class="h-9 px-3 shrink-0 cursor-pointer text-xs"
              >
                {{ testWebhookLoading ? '测试中...' : '测试' }}
              </Button>
            </div>
          </div>

          <div class="pt-2 flex gap-2.5">
            <Button
              type="button"
              variant="outline"
              @click="showSystemModal = false"
              class="flex-1 cursor-pointer"
            >
              取消
            </Button>
            <Button
              type="submit"
              :disabled="sysLoading"
              class="flex-1 shadow-xs cursor-pointer"
            >
              {{ sysLoading ? '正在保存...' : '保存配置' }}
            </Button>
          </div>
        </form>
      </AppDialog>

      <!-- 全局 Toaster 消息通知 -->
      <Toaster position="top-center" :close-button="true" />
      <!-- 全局确认框宿主 -->
      <ConfirmHost />
    </div>
  </TooltipProvider>
</template>
