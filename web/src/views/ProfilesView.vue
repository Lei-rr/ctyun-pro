<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { toast } from '@/shared/lib/toast';
import { useAppStore, type Account } from '@/stores/app';
import {
  Monitor,
  User,
  Play,
  Square,
  Trash2,
  Settings2,
  Plus,
  Pencil,
  Activity,
  CheckCircle2,
  Coins,
  Power,
  RotateCw,
  ExternalLink,
} from 'lucide-vue-next';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import AccountRenameDialog from '@/components/dialogs/AccountRenameDialog.vue';
import PointsTaskDialog from '@/components/dialogs/PointsTaskDialog.vue';
import PowerOperateDialog, { type PowerTarget } from '@/components/dialogs/PowerOperateDialog.vue';
import DesktopRenameDialog from '@/components/dialogs/DesktopRenameDialog.vue';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/shared/ui/table';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from '@/shared/ui/empty';

const store = useAppStore();

// 账号备注重命名
const showRenameModal = ref(false);
const renameOldName = ref('');

function openRename(name: string) {
  renameOldName.value = name;
  showRenameModal.value = true;
}

// 云电脑重命名
const showDesktopRenameModal = ref(false);
const renameDesktopCode = ref('');
const renameDesktopCurrentName = ref('');

function openDesktopRename(desktopCode: string, currentName: string) {
  renameDesktopCode.value = desktopCode;
  renameDesktopCurrentName.value = currentName || desktopCode;
  showDesktopRenameModal.value = true;
}

// 电源控制确认弹窗
const showPowerModal = ref(false);
const powerTarget = ref<PowerTarget | null>(null);

function openPowerConfirm(
  accountName: string,
  desktopCode: string,
  action: 'on' | 'shutdown' | 'reset',
  desktopName?: string,
) {
  powerTarget.value = {
    accountName,
    desktopCode,
    action,
    desktopName,
  };
  showPowerModal.value = true;
}

const directUrlLoading = ref<string | null>(null);

async function openDirectDesktop(desktopCode: string) {
  if (!desktopCode) {
    toast.error('未找到可用的云电脑实例');
    return;
  }

  directUrlLoading.value = desktopCode;
  try {
    // 顶级 RESTful 直连视窗 (标准 /desktop/:desktopCode 直连推流，符合全局 Desktops 架构标准)
    // 采用浏览器同源 Cookie 鉴权，地址栏严禁泄露 Token
    const adminToken = store.adminToken || localStorage.getItem('ctyun_admin_token') || '';
    if (adminToken) {
      try {
        document.cookie = `ctyun_admin_token=${encodeURIComponent(adminToken)}; path=/; max-age=${30 * 24 * 3600}; SameSite=Lax`;
      } catch (e) {}
    }
    const url = `/desktop/${encodeURIComponent(desktopCode)}`;
    const win = window.open(url, '_blank');
    if (!win) {
      toast.error('直连视窗被浏览器拦截，请在地址栏允许弹出窗口');
    }
  } finally {
    setTimeout(() => {
      directUrlLoading.value = null;
    }, 1000);
  }
}

function isAccountPaused(account: Account): boolean {
  return Boolean(account.desktops && account.desktops.some(d => d.status === 'paused'));
}

function getRedeemScheduleText(account: Account): string {
  const r = account.redeemConfig;
  if (!r || !r.enabled) return '';
  if (r.scheduleType === 'monthly_day') return `每月 ${r.monthlyDay || 28} 号`;
  if (r.scheduleType === 'interval_days') return `每 ${r.intervalDays || 4} 天`;
  if (r.scheduleType === 'specific_date') return `${r.specificDate || '指定日'}`;
  if (r.scheduleType === 'daily') return `每日`;
  return `月末`;
}

// 积分与每日任务弹窗
const showPointsModal = ref(false);
const pointsAccountName = ref('');

function openPointsModal(account: Account) {
  pointsAccountName.value = account.name || account.user;
  showPointsModal.value = true;
}

function parseDesktopSpec(desktop: any): string {
  const flavor = desktop.flavorName || '';
  const name = desktop.desktopName || '';
  const specMatch = flavor.match(/(\d+C\d+G)/i) || name.match(/(\d+C\d+G)/i);
  let spec = specMatch ? specMatch[1].toUpperCase() : '';

  if (!spec) {
    if (name.includes('旗舰版') || flavor.includes('旗舰版')) spec = '16C32G';
    else if (name.includes('尊享版') || flavor.includes('尊享版') || name.includes('精英版') || flavor.includes('精英版')) spec = '8C16G';
    else if (name.includes('标准版') || flavor.includes('标准版')) spec = '4C8G';
    else if (name.includes('政企') || flavor.includes('政企') || desktop.isPool) spec = '8C16G';
    else spec = '8C16G';
  }

  return spec;
}

// 避让秒级平滑自减计时器
let yieldSecondTimer: any = null;

onMounted(() => {
  yieldSecondTimer = setInterval(() => {
    for (const acc of store.accounts) {
      if (acc.desktops && Array.isArray(acc.desktops)) {
        for (const dt of acc.desktops) {
          if (dt.yieldStatus?.yielding) {
            if (dt.yieldStatus.remainingSeconds > 1) {
              dt.yieldStatus.remainingSeconds -= 1;
            } else {
              dt.yieldStatus.yielding = false;
              dt.yieldStatus.remainingSeconds = 0;
            }
          }
        }
      }
    }
  }, 1000);
});

onUnmounted(() => {
  if (yieldSecondTimer) {
    clearInterval(yieldSecondTimer);
    yieldSecondTimer = null;
  }
});
</script>

<template>
  <div class="flex flex-1 flex-col gap-6">
    <!-- 1. 统计指标卡片 (完全对齐 dns-pro Dashboard 样式：bg-muted/40 hover:bg-muted/60 transition-colors rounded-xl px-4 py-3) -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="bg-muted/40 hover:bg-muted/60 transition-colors rounded-xl px-4 py-3">
        <div class="text-xs font-medium text-muted-foreground">天翼云账号</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums mt-0.5">{{ store.totalAccounts }}</div>
      </div>
      <div class="bg-muted/40 hover:bg-muted/60 transition-colors rounded-xl px-4 py-3">
        <div class="text-xs font-medium text-muted-foreground">云电脑总数</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums mt-0.5">{{ store.totalDesktops }}</div>
      </div>
      <div class="bg-muted/40 hover:bg-muted/60 transition-colors rounded-xl px-4 py-3">
        <div class="text-xs font-medium text-muted-foreground">保活在线</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums text-emerald-500 mt-0.5">{{ store.onlineDesktops }}</div>
      </div>
      <div class="bg-muted/40 hover:bg-muted/60 transition-colors rounded-xl px-4 py-3">
        <div class="text-xs font-medium text-muted-foreground">今日已获积分</div>
        <div class="text-2xl font-bold tracking-tight tabular-nums text-amber-500 mt-0.5">
          +{{ store.accounts.reduce((sum, a) => sum + (a.todayPoints || 0), 0) }}
        </div>
      </div>
    </div>

    <!-- 2. 页面标题栏与操作按钮 -->
    <div class="flex flex-col gap-3 min-[360px]:flex-row min-[360px]:items-center min-[360px]:justify-between">
      <div class="min-w-0 space-y-0.5">
        <h1 class="text-2xl font-bold tracking-tight">天翼云账号管理</h1>
        <p class="text-muted-foreground text-sm">
          <template v-if="store.totalAccounts === 0">暂未配置任何天翼云账号</template>
          <template v-else>已接入 {{ store.totalAccounts }} 个天翼云账号，自动发现并保持长连防休眠</template>
        </p>
      </div>

      <div class="flex items-center gap-2">
        <Button
          size="sm"
          class="gap-1.5 cursor-pointer shadow-xs"
          @click="store.openAddModal()"
        >
          <Plus class="size-4" />
          添加账号
        </Button>
      </div>
    </div>

    <!-- 3. 空状态 (完全采用 dns-pro Empty 组件) -->
    <Empty v-if="store.accounts.length === 0" class="border border-dashed border-border/70 rounded-2xl py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Monitor class="size-6 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>暂无天翼云账号</EmptyTitle>
        <EmptyDescription>
          接入天翼云账号后，系统将自动识别验证码、绑定设备并建立云电脑 WebSocket 保活
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" class="gap-1.5 shadow-xs cursor-pointer" @click="store.openAddModal()">
          <Plus class="size-4" />
          立即添加账号
        </Button>
      </EmptyContent>
    </Empty>

    <!-- 4. 账号列表：通透大气的卡片流 (严格遵循 shadcn-vue 极简质感，忌生硬深边框) -->
    <div v-else class="space-y-4">
      <div
        v-for="account in store.accounts"
        :key="account.name"
        class="group rounded-2xl border border-border/40 hover:border-border/80 bg-card p-4 sm:p-5 transition-all space-y-4 shadow-2xs"
      >
        <!-- 账号头部 -->
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-3.5 min-w-0">
            <div class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground border border-border/40 shadow-2xs">
              <User class="size-5 text-muted-foreground" />
            </div>
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="truncate text-base font-semibold tracking-tight text-foreground">{{ account.name }}</span>
                <button
                  @click="openRename(account.name)"
                  class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md cursor-pointer hover:bg-muted/60"
                  title="修改账号备注名称"
                >
                  <Pencil class="size-3.5" />
                </button>
                <span class="text-xs text-muted-foreground font-mono">({{ account.loginInfo?.mobilephone || account.user }})</span>
                <Badge
                  variant="outline"
                  class="gap-1.5 font-normal px-2.5 py-0.5 h-6 shrink-0 transition-colors"
                  :class="{
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': account.status === 'online',
                    'bg-muted/80 text-muted-foreground border-border/40': account.status === 'idle',
                    'bg-destructive/10 text-destructive border border-destructive/20': account.status === 'error',
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': account.status === 'login_needed' || account.status === 'need_sms' || isAccountPaused(account),
                  }"
                >
                  <span
                    v-if="account.status === 'online'"
                    class="relative flex size-1.5 shrink-0"
                  >
                    <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                    <span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
                  </span>
                  <span
                    v-else-if="isAccountPaused(account)"
                    class="size-1.5 rounded-full bg-amber-500 shrink-0"
                  ></span>
                  <span>{{ isAccountPaused(account) ? '暂停探测中' : (account.status === 'online' ? '保活中' : account.status === 'idle' ? '已停止' : account.status === 'error' ? '异常' : '需认证') }}</span>
                </Badge>
                <!-- 仅在账号处于保活中且开启 AI 对话任务时显示简约标签 -->
                <Badge v-if="account.status === 'online' && account.taskConfig?.enabled" variant="outline" class="h-5 shrink-0 px-2 text-[11px] font-normal border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                  AI 对话
                </Badge>
                <Badge v-if="account.status === 'online' && account.redeemConfig?.enabled" variant="outline" class="h-5 shrink-0 px-2 text-[11px] font-normal border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                  自动兑换 ({{ getRedeemScheduleText(account) }})
                </Badge>
              </div>
              <div class="text-xs text-muted-foreground font-mono truncate">
                设备指纹: {{ account.deviceCode }}
              </div>
            </div>
          </div>

          <!-- 操作栏：立即做任务、积分查看、策略配置与控制 -->
          <div class="flex flex-wrap items-center gap-1.5 sm:self-center">
            <Button
              variant="outline"
              size="sm"
              class="h-8 px-2.5 text-xs gap-1 cursor-pointer border-border/60 hover:text-emerald-500 hover:border-emerald-500/40"
              @click="openPointsModal(account)"
              title="查看积分明细与任务进度"
            >
              <Coins class="size-3.5 text-amber-500" />
              任务积分
            </Button>

            <Button
              variant="outline"
              size="sm"
              class="h-8 px-2.5 text-xs gap-1 cursor-pointer border-border/60"
              @click="store.openPolicyModal(account)"
              title="配置每日任务与自动兑换策略"
            >
              <Settings2 class="size-3.5" />
              策略设置
            </Button>

            <!-- 认证异常状态 -->
            <Button
              v-if="account.status === 'login_needed' || account.status === 'need_sms'"
              size="sm"
              class="h-8 px-3 text-xs bg-amber-500 hover:bg-amber-600 text-white cursor-pointer"
              @click="store.openAddModal(account.name, account.user)"
            >
              去认证
            </Button>

            <!-- 三态控制按钮组：开启 / 停止 -->
            <template v-else>
              <!-- 开启保活按钮 (非 online 状态均可点击开启) -->
              <Button
                v-if="account.status !== 'online'"
                variant="secondary"
                size="sm"
                class="h-8 px-2.5 text-xs gap-1 cursor-pointer text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                @click="store.accountAction(account.name, 'start')"
                title="开启后台长连接保活"
              >
                <Play class="size-3.5 fill-current" />
                开启
              </Button>

              <!-- 彻底停止按钮 (当未彻底停止时可点击) -->
              <Button
                v-if="account.status === 'online' || isAccountPaused(account)"
                variant="secondary"
                size="sm"
                class="h-8 px-2.5 text-xs gap-1 cursor-pointer text-destructive/80 hover:bg-destructive/10"
                @click="store.accountAction(account.name, 'stop')"
                title="彻底停止保活：断开长连接且彻底不发起任何探测，完全静止"
              >
                <Square class="size-3.5 fill-current" />
                停止
              </Button>
            </template>

            <Button
              variant="ghost"
              size="icon"
              class="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
              @click="store.accountAction(account.name, 'delete')"
              title="删除账号"
            >
              <Trash2 class="size-4" />
            </Button>
          </div>
        </div>

        <!-- 云电脑实例列表：桌面端采用固定列宽表格，文字变化绝不抖动变形 -->
        <div v-if="account.desktops && account.desktops.length > 0" class="pt-1">
          <!-- 桌面端表格 (sm 以上) -->
          <div class="hidden sm:block overflow-x-auto">
            <Table class="table-fixed w-full">
              <TableHeader>
                <TableRow class="hover:bg-transparent border-border/60">
                  <TableHead class="h-9 text-xs font-medium w-[22%]">云电脑名称</TableHead>
                  <TableHead class="h-9 text-xs font-medium w-[14%]">硬件规格</TableHead>
                  <TableHead class="h-9 text-xs font-medium w-[18%]">实例代码 / ID</TableHead>
                  <TableHead class="h-9 text-xs font-medium w-[13%]">云端状态</TableHead>
                  <TableHead class="h-9 text-xs font-medium w-[13%]">保活长连</TableHead>
                  <TableHead class="h-9 text-xs font-medium w-[10%] text-right">最近心跳</TableHead>
                  <TableHead class="h-9 text-xs font-medium w-[10%] text-right pr-2">控制</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <template v-for="desktop in account.desktops" :key="desktop.desktopCode">
                  <TableRow class="border-border/30 hover:bg-muted/30 transition-colors">
                    <TableCell class="py-2.5 font-medium text-foreground truncate">
                      <div class="flex items-center gap-2 min-w-0 group/dtname">
                        <Monitor class="size-4 text-muted-foreground shrink-0" />
                        <span class="truncate" :title="desktop.desktopName">{{ desktop.desktopName || '云电脑' }}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="size-5 rounded-sm p-0 opacity-0 group-hover/dtname:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0"
                          title="修改云电脑名称"
                          @click="openDesktopRename(desktop.desktopCode, desktop.desktopName)"
                        >
                          <Pencil class="size-3" />
                        </Button>
                        <Badge v-if="desktop.isPool || (desktop.desktopName && desktop.desktopName.includes('桌面池'))" variant="outline" class="h-4 px-1 text-[9px] font-normal border-amber-500/30 text-amber-500 shrink-0">
                          政企桌面池
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell class="py-2.5 whitespace-nowrap">
                      <div class="flex items-center gap-1.5">
                        <Badge variant="outline" class="h-5 px-1.5 text-[10px] font-mono border-primary/30 text-primary">
                           {{ parseDesktopSpec(desktop) }}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell class="py-2.5 font-mono text-xs text-muted-foreground truncate">
                      <span class="truncate block" :title="desktop.desktopCode">{{ desktop.desktopCode }}</span>
                    </TableCell>
                    <TableCell class="py-2.5 whitespace-nowrap">
                      <Badge
                        variant="secondary"
                        class="h-5 px-2 text-[11px] font-normal"
                        :class="{
                          'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20': desktop.yieldStatus?.yielding,
                          'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': !desktop.yieldStatus?.yielding && (desktop.useStatusText === '运行中' || desktop.status === 'connected'),
                          'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': !desktop.yieldStatus?.yielding && (desktop.status === 'connecting' || desktop.status === 'paused'),
                          'bg-muted text-muted-foreground': !desktop.yieldStatus?.yielding && desktop.useStatusText !== '运行中' && desktop.status !== 'connected' && desktop.status !== 'connecting' && desktop.status !== 'paused',
                        }"
                        :title="desktop.yieldStatus?.yielding ? (desktop.yieldStatus.reason || '检测到外部官方客户端在线，系统主动避让中') : ''"
                      >
                        {{ desktop.yieldStatus?.yielding ? `避让中 (${desktop.yieldStatus.remainingSeconds}s)` : (desktop.status === 'paused' ? '暂停探测中' : (desktop.status === 'connected' ? '运行中' : (desktop.status === 'connecting' && desktop.useStatusText === '已关机' ? '开机就绪中' : (desktop.useStatusText || '已关机')))) }}
                      </Badge>
                    </TableCell>
                    <TableCell class="py-2.5 whitespace-nowrap">
                      <div class="flex items-center gap-1.5 text-xs font-medium">
                        <span
                          class="size-2 rounded-full shrink-0"
                          :class="desktop.yieldStatus?.yielding ? 'bg-purple-500' : (desktop.status === 'connected' ? 'bg-emerald-500 animate-pulse' : (desktop.status === 'connecting' ? 'bg-amber-400 animate-ping' : (desktop.status === 'paused' ? 'bg-amber-500' : 'bg-muted-foreground/30')))"
                        ></span>
                        <span :class="desktop.yieldStatus?.yielding ? 'text-purple-600 dark:text-purple-400' : (desktop.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : (desktop.status === 'paused' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'))" class="truncate">
                           {{ desktop.yieldStatus?.yielding ? '主动避让' : (desktop.status === 'connected' ? '在线' : desktop.status === 'connecting' ? '正在连接' : (desktop.status === 'paused' ? (desktop.watchdog?.nextProbeSec ? `避让中(${desktop.watchdog.nextProbeSec}s)` : '避让探针中') : '已停止')) }}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell class="py-2.5 font-mono text-xs text-muted-foreground text-right tabular-nums whitespace-nowrap">
                      {{ desktop.lastHeartbeat || '-' }}
                    </TableCell>
                    <TableCell class="py-2.5 text-right whitespace-nowrap pr-2">
                      <div class="inline-flex items-center gap-1 justify-end">
                        <!-- 远程桌面直通按钮 (新标签页打开官方视窗) -->
                        <Button
                          variant="ghost"
                          size="icon"
                          class="size-7 text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer"
                          :title="desktop.useStatusText === '运行中' ? '进入远程桌面 (官方Web直连)' : '获取免密直连 (若未开机需先开机)'"
                          :disabled="directUrlLoading === desktop.desktopCode"
                          @click="openDirectDesktop(desktop.desktopCode)"
                        >
                          <RotateCw
                            v-if="directUrlLoading === desktop.desktopCode"
                            class="size-3.5 animate-spin text-primary"
                          />
                          <ExternalLink v-else class="size-3.5" />
                        </Button>
                        <!-- 关机状态：显示开机图标 -->
                        <Button
                          v-if="!(desktop.useStatusText === '运行中' && desktop.status === 'connected')"
                          variant="ghost"
                          size="icon"
                          class="size-7 text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10 cursor-pointer"
                          title="开机"
                          @click="openPowerConfirm(account.name, desktop.desktopCode, 'on', desktop.desktopName || desktop.desktopCode)"
                        >
                          <Power class="size-3.5" />
                        </Button>
                        <!-- 运行中状态：并列显示 重启 与 关机 图标 -->
                        <template v-else>
                          <Button
                            variant="ghost"
                            size="icon"
                            class="size-7 text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 cursor-pointer"
                            title="重启"
                            @click="openPowerConfirm(account.name, desktop.desktopCode, 'reset', desktop.desktopName || desktop.desktopCode)"
                          >
                            <RotateCw class="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            class="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                            title="关机"
                            @click="openPowerConfirm(account.name, desktop.desktopCode, 'shutdown', desktop.desktopName || desktop.desktopCode)"
                          >
                            <Power class="size-3.5" />
                          </Button>
                        </template>
                      </div>
                    </TableCell>
                  </TableRow>
                </template>
              </TableBody>
            </Table>
          </div>

          <!-- 手机端紧凑卡片流 (sm 以下展示) -->
          <div class="sm:hidden space-y-2">
            <div
              v-for="desktop in account.desktops"
              :key="desktop.desktopCode"
              class="p-3 rounded-xl bg-muted/30 border border-border/40 space-y-2"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 font-medium text-sm text-foreground min-w-0">
                  <Monitor class="size-4 text-muted-foreground shrink-0" />
                  <span class="truncate">{{ desktop.desktopName || '云电脑' }}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground shrink-0"
                    title="修改云电脑名称"
                    @click="openDesktopRename(desktop.desktopCode, desktop.desktopName)"
                  >
                    <Pencil class="size-3" />
                  </Button>
                  <Badge variant="outline" class="h-4 px-1.5 text-[10px] font-mono border-primary/40 text-primary shrink-0">
                     {{ parseDesktopSpec(desktop) }}
                  </Badge>
                </div>
                <Badge
                  variant="secondary"
                  class="h-5 px-1.5 text-[11px] font-normal"
                  :class="{
                    'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20': desktop.yieldStatus?.yielding,
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': !desktop.yieldStatus?.yielding && (desktop.useStatusText === '运行中' || desktop.status === 'connected'),
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': !desktop.yieldStatus?.yielding && (desktop.status === 'connecting' || desktop.status === 'paused'),
                    'bg-muted text-muted-foreground': !desktop.yieldStatus?.yielding && desktop.useStatusText !== '运行中' && desktop.status !== 'connected' && desktop.status !== 'connecting' && desktop.status !== 'paused',
                  }"
                  :title="desktop.yieldStatus?.yielding ? (desktop.yieldStatus.reason || '检测到外部官方客户端在线，系统主动避让中') : ''"
                >
                  {{ desktop.yieldStatus?.yielding ? `避让中 (${desktop.yieldStatus.remainingSeconds}s)` : (desktop.status === 'paused' ? '暂停探测中' : (desktop.status === 'connected' ? '运行中' : (desktop.status === 'connecting' && desktop.useStatusText === '已关机' ? '开机就绪中' : (desktop.useStatusText || '已关机')))) }}
                </Badge>
              </div>
              <div class="flex items-center justify-between text-xs text-muted-foreground font-mono">
                <span class="truncate">ID: {{ desktop.desktopCode }}</span>
                <span class="shrink-0 ml-2">{{ desktop.lastHeartbeat || '无心跳' }}</span>
              </div>
              <div class="flex items-center justify-between pt-1 border-t border-border/30">
                <div class="flex items-center gap-1.5 text-xs">
                  <span
                    class="size-2 rounded-full"
                    :class="desktop.yieldStatus?.yielding ? 'bg-purple-500' : (desktop.status === 'connected' ? 'bg-emerald-500 animate-pulse' : (desktop.status === 'connecting' ? 'bg-amber-400 animate-ping' : (desktop.status === 'paused' ? 'bg-amber-500' : 'bg-muted-foreground/30')))"
                  ></span>
                  <span :class="desktop.yieldStatus?.yielding ? 'text-purple-600 dark:text-purple-400' : (desktop.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : (desktop.status === 'paused' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'))">
                     {{ desktop.yieldStatus?.yielding ? '主动避让' : (desktop.status === 'connected' ? '在线' : desktop.status === 'connecting' ? '正在连接' : (desktop.status === 'paused' ? (desktop.watchdog?.nextProbeSec ? `避让中(${desktop.watchdog.nextProbeSec}s)` : '避让探针中') : '已停止')) }}
                  </span>
                </div>
                <div class="inline-flex items-center gap-1">
                  <!-- 远程桌面直通按钮 (新标签页打开官方视窗) -->
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-7 text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer"
                    :title="desktop.useStatusText === '运行中' ? '进入远程桌面 (官方Web直连)' : '获取免密直连 (若未开机需先开机)'"
                    :disabled="directUrlLoading === desktop.desktopCode"
                    @click="openDirectDesktop(desktop.desktopCode)"
                  >
                    <RotateCw
                      v-if="directUrlLoading === desktop.desktopCode"
                      class="size-3.5 animate-spin text-primary"
                    />
                    <ExternalLink v-else class="size-3.5" />
                  </Button>
                  <!-- 关机状态：显示开机图标 -->
                  <Button
                    v-if="!(desktop.useStatusText === '运行中' && desktop.status === 'connected')"
                    variant="ghost"
                    size="icon"
                    class="size-7 text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10 cursor-pointer"
                    title="开机"
                    @click="openPowerConfirm(account.name, desktop.desktopCode, 'on', desktop.desktopName || desktop.desktopCode)"
                  >
                    <Power class="size-3.5" />
                  </Button>
                  <!-- 运行中状态：并列显示 重启 与 关机 图标 -->
                  <template v-else>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-7 text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 cursor-pointer"
                      title="重启"
                      @click="openPowerConfirm(account.name, desktop.desktopCode, 'reset', desktop.desktopName || desktop.desktopCode)"
                    >
                      <RotateCw class="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                      title="关机"
                      @click="openPowerConfirm(account.name, desktop.desktopCode, 'shutdown', desktop.desktopName || desktop.desktopCode)"
                    >
                      <Power class="size-3.5" />
                    </Button>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="text-xs text-muted-foreground py-4 text-center bg-muted/20 rounded-xl border border-dashed border-border/40">
          暂未同步到名下云电脑实例，点击「保活」即可自动登录拉取
        </div>
      </div>
    </div>

    <!-- 弹窗 1: 账号重命名弹窗 -->
    <AccountRenameDialog
      v-model:open="showRenameModal"
      :account-name="renameOldName"
    />

    <!-- 弹窗 2: 积分与今日任务进度详情 -->
    <PointsTaskDialog
      v-model:open="showPointsModal"
      :account-name="pointsAccountName"
    />

    <!-- 弹窗 3: 电源操作二次确认弹窗 -->
    <PowerOperateDialog
      v-model:open="showPowerModal"
      :target="powerTarget"
    />

    <!-- 弹窗 4: 云电脑名称重命名弹窗 -->
    <DesktopRenameDialog
      v-model:open="showDesktopRenameModal"
      :desktop-code="renameDesktopCode"
      :current-name="renameDesktopCurrentName"
    />
  </div>
</template>
