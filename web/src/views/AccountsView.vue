<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
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
  Sparkles,
  Clock,
  MessageSquare,
  Power,
  RotateCw,
  Zap,
} from 'lucide-vue-next';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Input } from '@/shared/ui/input';
import { AppDialog } from '@/shared/ui/dialog';
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
const renameInputVal = ref('');
const renameLoading = ref(false);

function openRename(name: string) {
  renameOldName.value = name;
  renameInputVal.value = name;
  showRenameModal.value = true;
}

async function submitRename() {
  if (!renameInputVal.value.trim()) return;
  renameLoading.value = true;
  try {
    await store.renameAccount(renameOldName.value, renameInputVal.value.trim());
    showRenameModal.value = false;
  } finally {
    renameLoading.value = false;
  }
}

function getRedeemScheduleText(account: Account): string {
  const r = account.redeemConfig;
  if (!r || !r.enabled) return '';
  if (r.scheduleType === 'monthly_day') return `每月 ${r.monthlyDay || 28} 号`;
  if (r.scheduleType === 'interval_days') return `每 ${r.intervalDays || 30} 天`;
  if (r.scheduleType === 'specific_date') return `${r.specificDate || '指定日'}`;
  if (r.scheduleType === 'daily') return `每日`;
  return `月末`;
}

// 积分与每日任务弹窗
const showPointsModal = ref(false);
const pointsAccountName = ref('');
const pointsLoading = ref(false);
const taskRunning = ref(false);
const hangRunning = ref(false);
const loginRunning = ref(false);
const chatRunning = ref(false);
const pointsData = ref<{
  generalPoints: number;
  phonePoints: number;
  willExpirePoints: number;
  expireDate?: string;
  tasks: Array<{
    name: string;
    desc: string;
    rewardPoints: number;
    currentProgress: number;
    totalProgress: number;
    isCompleted: boolean;
  }>;
} | null>(null);

async function openPointsModal(account: Account) {
  pointsAccountName.value = account.name || account.user;
  showPointsModal.value = true;
  pointsLoading.value = true;
  try {
    pointsData.value = await store.fetchPointsAndTasks(account.user || account.name);
  } catch {
    pointsData.value = null;
  } finally {
    pointsLoading.value = false;
  }
}

async function runTaskInModal() {
  if (!pointsAccountName.value) return;
  taskRunning.value = true;
  try {
    await store.manualRunTasks(pointsAccountName.value);
    pointsData.value = await store.fetchPointsAndTasks(pointsAccountName.value);
  } finally {
    taskRunning.value = false;
  }
}

async function runHangInModal() {
  if (!pointsAccountName.value || hangRunning.value) return;
  hangRunning.value = true;
  try {
    await store.manualActivateDesktop(pointsAccountName.value);
    showPointsModal.value = false; // 启动挂机后立即关闭弹窗回到桌面列表
  } finally {
    hangRunning.value = false;
  }
}

async function runLoginTaskInModal() {
  if (!pointsAccountName.value || loginRunning.value) return;
  loginRunning.value = true;
  try {
    await store.manualLoginDesktopTask(pointsAccountName.value);
    pointsData.value = await store.fetchPointsAndTasks(pointsAccountName.value);
  } finally {
    loginRunning.value = false;
  }
}

async function runAiChatTaskInModal() {
  if (!pointsAccountName.value || chatRunning.value) return;
  chatRunning.value = true;
  try {
    await store.manualAiChatTask(pointsAccountName.value);
    pointsData.value = await store.fetchPointsAndTasks(pointsAccountName.value);
  } finally {
    chatRunning.value = false;
  }
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

// 挂机秒级平滑自增计时器 (按秒累加进度)
let hangSecondTimer: any = null;

onMounted(() => {
  hangSecondTimer = setInterval(() => {
    for (const acc of store.accounts) {
      if (acc.hangStatus?.running) {
        const cur = acc.hangStatus.currentProgress || 0;
        const tot = acc.hangStatus.totalProgress || 3600;
        if (cur < tot) {
          acc.hangStatus.currentProgress = cur + 1;
        }
      }
    }
  }, 1000);
});

onUnmounted(() => {
  if (hangSecondTimer) {
    clearInterval(hangSecondTimer);
    hangSecondTimer = null;
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
                <span class="text-xs text-muted-foreground font-mono">({{ account.user }})</span>
                <Badge
                  variant="secondary"
                  class="h-5 shrink-0 px-2 text-[11px] font-normal flex items-center gap-1.5"
                  :class="{
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': account.status === 'online' || account.hangStatus?.running,
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': account.status === 'login_needed' || account.status === 'need_sms',
                    'bg-destructive/10 text-destructive border border-destructive/20': account.status === 'error',
                  }"
                >
                  <span
                    v-if="account.status === 'online' || account.hangStatus?.running"
                    class="relative flex size-1.5 shrink-0"
                  >
                    <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                    <span class="relative inline-flex size-1.5 rounded-full bg-emerald-500"></span>
                  </span>
                  <span>{{ account.hangStatus?.running ? '挂机中' : (account.status === 'online' ? '保活中' : account.status === 'idle' ? '就绪' : account.status === 'error' ? '异常' : '需认证') }}</span>
                </Badge>
                 <Badge v-if="account.taskConfig?.enabled" variant="outline" class="h-5 shrink-0 px-2 text-[11px] font-normal border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                   每日任务 ({{ account.taskConfig?.scheduleTime || '08:00' }})
                 </Badge>
                 <Badge v-if="account.redeemConfig?.enabled" variant="outline" class="h-5 shrink-0 px-2 text-[11px] font-normal border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                   自动兑换
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

            <Button
              v-if="account.status === 'login_needed' || account.status === 'need_sms'"
              size="sm"
              class="h-8 px-3 text-xs bg-amber-500 hover:bg-amber-600 text-white cursor-pointer"
              @click="store.openAddModal(account.name, account.user)"
            >
              去认证
            </Button>

            <Button
              v-else-if="account.status !== 'online'"
              variant="secondary"
              size="sm"
              class="h-8 px-3 text-xs gap-1.5 cursor-pointer text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
              @click="store.accountAction(account.name, 'start')"
            >
              <Play class="size-3.5 fill-current" />
              保活
            </Button>

            <Button
              v-else
              variant="secondary"
              size="sm"
              class="h-8 px-3 text-xs gap-1.5 cursor-pointer"
              @click="store.accountAction(account.name, 'stop')"
            >
              <Square class="size-3.5 fill-current" />
              停止
            </Button>

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
                <template v-for="desktop in account.desktops" :key="desktop.desktopId">
                  <TableRow class="border-border/30 hover:bg-muted/30 transition-colors">
                    <TableCell class="py-2.5 font-medium text-foreground truncate">
                      <div class="flex items-center gap-2 min-w-0">
                        <Monitor class="size-4 text-muted-foreground shrink-0" />
                        <span class="truncate" :title="desktop.desktopName">{{ desktop.desktopName || '云电脑' }}</span>
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
                      <span class="truncate block" :title="desktop.desktopCode || desktop.desktopId">{{ desktop.desktopCode || desktop.desktopId }}</span>
                    </TableCell>
                    <TableCell class="py-2.5 whitespace-nowrap">
                      <Badge
                        variant="secondary"
                        class="h-5 px-2 text-[11px] font-normal"
                        :class="{
                          'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': account.hangStatus?.running || desktop.status === 'hanging' || desktop.useStatusText === '运行中' || desktop.status === 'connected',
                          'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': !(account.hangStatus?.running || desktop.status === 'hanging') && desktop.useStatusText !== '运行中' && desktop.status === 'connecting',
                          'bg-muted text-muted-foreground': !(account.hangStatus?.running || desktop.status === 'hanging') && desktop.useStatusText !== '运行中' && desktop.status !== 'connected' && desktop.status !== 'connecting',
                        }"
                      >
                        {{ account.hangStatus?.running || desktop.status === 'hanging' ? '挂机中' : (desktop.status === 'connected' ? '运行中' : (desktop.status === 'connecting' && desktop.useStatusText === '已关机' ? '开机就绪中' : (desktop.useStatusText || '已关机'))) }}
                      </Badge>
                    </TableCell>
                    <TableCell class="py-2.5 whitespace-nowrap">
                      <div class="flex items-center gap-1.5 text-xs font-medium">
                        <span
                          class="size-2 rounded-full shrink-0"
                          :class="account.hangStatus?.running || desktop.status === 'hanging' || desktop.status === 'connected' ? 'bg-emerald-500 animate-pulse' : (desktop.status === 'connecting' ? 'bg-amber-400 animate-ping' : 'bg-muted-foreground/30')"
                        ></span>
                        <span :class="account.hangStatus?.running || desktop.status === 'hanging' || desktop.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'" class="truncate">
                           {{ account.hangStatus?.running || desktop.status === 'hanging' ? '浏览器挂机' : (desktop.status === 'connected' ? '在线' : desktop.status === 'connecting' ? '正在连接' : '未连接') }}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell class="py-2.5 font-mono text-xs text-muted-foreground text-right tabular-nums whitespace-nowrap">
                      {{ desktop.lastHeartbeat || '-' }}
                    </TableCell>
                    <TableCell class="py-2.5 text-right whitespace-nowrap pr-2">
                      <div class="inline-flex items-center gap-1 justify-end">
                        <Button
                           v-if="!(desktop.useStatusText === '运行中' && desktop.status === 'connected')"
                          variant="ghost"
                          size="icon"
                          class="size-7 text-muted-foreground hover:text-emerald-500 hover:bg-emerald-500/10 cursor-pointer"
                          title="开机"
                          @click="store.operateDesktopPower(account.name, desktop.desktopId, 'on')"
                        >
                          <Power class="size-3.5" />
                        </Button>
                        <Button
                          v-else
                          variant="ghost"
                          size="icon"
                          class="size-7 text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 cursor-pointer"
                          title="重启"
                          @click="store.operateDesktopPower(account.name, desktop.desktopId, 'reset')"
                        >
                          <RotateCw class="size-3.5" />
                        </Button>
                        <Button
                           v-if="desktop.useStatusText === '运行中' && desktop.status === 'connected'"
                          variant="ghost"
                          size="icon"
                          class="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                          title="关机"
                          @click="store.operateDesktopPower(account.name, desktop.desktopId, 'shutdown')"
                        >
                          <Power class="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>

                  <!-- 云电脑下方长条挂机进度条 (仅挂机中展示) -->
                  <TableRow
                    v-if="account.hangStatus?.running"
                    class="hover:bg-transparent border-b border-border/20"
                  >
                    <TableCell colspan="7" class="py-1 px-4">
                      <div class="flex items-center gap-3">
                        <span class="text-[11px] font-medium text-foreground shrink-0 flex items-center gap-1.5">
                          <span class="size-1.5 rounded-full bg-neutral-900 dark:bg-neutral-100 animate-pulse"></span>
                          挂机进度
                        </span>
                        <div class="h-1 flex-1 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
                          <div
                            class="h-full bg-neutral-900 dark:bg-neutral-100 rounded-full transition-all duration-500"
                            :style="{
                              width: Math.min(100, Math.max(0, Math.floor(((account.hangStatus.currentProgress || 0) / (account.hangStatus.totalProgress || 3600)) * 100))) + '%'
                            }"
                          ></div>
                        </div>
                        <span class="text-[11px] font-mono font-medium text-foreground tabular-nums shrink-0">
                          {{ account.hangStatus.currentProgress || 0 }} / {{ account.hangStatus.totalProgress || 3600 }} 秒
                          ({{ Math.floor(((account.hangStatus.currentProgress || 0) / (account.hangStatus.totalProgress || 3600)) * 100) }}%)
                          · 剩余约 {{ Math.ceil(Math.max(0, (account.hangStatus.totalProgress || 3600) - (account.hangStatus.currentProgress || 0)) / 60) }} 分钟
                        </span>
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
              :key="desktop.desktopId"
              class="p-3 rounded-xl bg-muted/30 border border-border/40 space-y-2"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 font-medium text-sm text-foreground min-w-0">
                  <Monitor class="size-4 text-muted-foreground shrink-0" />
                  <span class="truncate">{{ desktop.desktopName || '云电脑' }}</span>
                  <Badge variant="outline" class="h-4 px-1.5 text-[10px] font-mono border-primary/40 text-primary shrink-0">
                     {{ parseDesktopSpec(desktop) }}
                  </Badge>
                </div>
                <Badge
                  variant="secondary"
                  class="h-5 px-1.5 text-[11px] font-normal"
                  :class="{
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': account.hangStatus?.running || desktop.status === 'hanging' || desktop.useStatusText === '运行中' || desktop.status === 'connected',
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': !(account.hangStatus?.running || desktop.status === 'hanging') && desktop.useStatusText !== '运行中' && desktop.status === 'connecting',
                    'bg-muted text-muted-foreground': !(account.hangStatus?.running || desktop.status === 'hanging') && desktop.useStatusText !== '运行中' && desktop.status !== 'connected' && desktop.status !== 'connecting',
                  }"
                >
                  {{ account.hangStatus?.running || desktop.status === 'hanging' ? '挂机中' : (desktop.status === 'connected' ? '运行中' : (desktop.status === 'connecting' && desktop.useStatusText === '已关机' ? '开机就绪中' : (desktop.useStatusText || '已关机'))) }}
                </Badge>
              </div>
              <div class="flex items-center justify-between text-xs text-muted-foreground font-mono">
                <span class="truncate">ID: {{ desktop.desktopCode || desktop.desktopId }}</span>
                <span class="shrink-0 ml-2">{{ desktop.lastHeartbeat || '无心跳' }}</span>
              </div>
              <div class="flex items-center justify-between pt-1 border-t border-border/30">
                <div class="flex items-center gap-1.5 text-xs">
                  <span
                    class="size-2 rounded-full"
                    :class="account.hangStatus?.running || desktop.status === 'hanging' || desktop.status === 'connected' ? 'bg-emerald-500 animate-pulse' : (desktop.status === 'connecting' ? 'bg-amber-400 animate-ping' : 'bg-muted-foreground/30')"
                  ></span>
                  <span :class="account.hangStatus?.running || desktop.status === 'hanging' || desktop.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'">
                     {{ account.hangStatus?.running || desktop.status === 'hanging' ? '浏览器挂机' : (desktop.status === 'connected' ? '在线' : desktop.status === 'connecting' ? '正在连接' : '未连接') }}
                  </span>
                </div>
                <div class="inline-flex items-center gap-1">
                  <Button
                     v-if="!(desktop.useStatusText === '运行中' && desktop.status === 'connected')"
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-[11px] text-emerald-600 dark:text-emerald-400 cursor-pointer"
                    @click="store.operateDesktopPower(account.name, desktop.desktopId, 'on')"
                  >
                    开机
                  </Button>
                   <Button
                     v-if="desktop.useStatusText === '运行中' && desktop.status === 'connected'"
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-[11px] text-destructive cursor-pointer"
                    @click="store.operateDesktopPower(account.name, desktop.desktopId, 'shutdown')"
                  >
                    关机
                  </Button>
                </div>
              </div>

              <!-- 手机端云电脑下方长条挂机进度条 -->
              <div
                v-if="account.hangStatus?.running"
                class="pt-1 mt-1 border-t border-border/20 space-y-1"
              >
                <div class="flex items-center justify-between text-[11px] font-mono text-foreground">
                  <span class="flex items-center gap-1">
                    <span class="size-1.5 rounded-full bg-neutral-900 dark:bg-neutral-100 animate-pulse"></span>
                    挂机进度
                  </span>
                  <span>{{ account.hangStatus.currentProgress || 0 }}/{{ account.hangStatus.totalProgress || 3600 }}秒 ({{ Math.floor(((account.hangStatus.currentProgress || 0) / (account.hangStatus.totalProgress || 3600)) * 100) }}%)</span>
                </div>
                <div class="h-1 w-full bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-neutral-900 dark:bg-neutral-100 rounded-full transition-all duration-500"
                    :style="{
                      width: Math.min(100, Math.max(0, Math.floor(((account.hangStatus.currentProgress || 0) / (account.hangStatus.totalProgress || 3600)) * 100))) + '%'
                    }"
                  ></div>
                </div>
                <div class="text-[10px] text-right text-muted-foreground font-mono">
                  剩余约 {{ Math.ceil(Math.max(0, (account.hangStatus.totalProgress || 3600) - (account.hangStatus.currentProgress || 0)) / 60) }} 分钟
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

    <!-- 弹窗 1: 账号重命名弹窗 (AppDialog) -->
    <AppDialog
      v-model:open="showRenameModal"
      title="修改账号备注"
      description="给天翼云账号设置一个更易辨识的备注名称"
      content-class="sm:max-w-sm"
    >
      <form @submit.prevent="submitRename" class="space-y-3.5">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-foreground">账号新备注</label>
          <Input
            type="text"
            v-model="renameInputVal"
            placeholder="例如：主账号 / 二号机"
            required
            autofocus
            class="h-9"
          />
        </div>

        <div class="pt-2 flex gap-2 w-full">
          <Button
            type="button"
            variant="outline"
            @click="showRenameModal = false"
            class="flex-1 h-9 cursor-pointer"
          >
            取消
          </Button>
          <Button
            type="submit"
            :disabled="renameLoading || !renameInputVal.trim()"
            class="flex-1 h-9 shadow-xs cursor-pointer"
          >
            {{ renameLoading ? '正在保存...' : '确认修改' }}
          </Button>
        </div>
      </form>
    </AppDialog>

    <!-- 弹窗 2: 积分与三大每日任务进度详情 (AppDialog) -->
    <AppDialog
      v-model:open="showPointsModal"
      title="积分与今日任务"
      :description="`账号 [${pointsAccountName}] 当前可用积分与每日三大任务进度`"
      content-class="sm:max-w-md"
    >
      <div v-if="pointsLoading" class="py-10 text-center text-xs text-muted-foreground">
        正在拉取天翼云最新积分与三大任务进度...
      </div>

      <div v-else-if="pointsData" class="space-y-4">
        <!-- 积分概况卡片 -->
        <div class="grid grid-cols-2 gap-2.5 p-3.5 rounded-xl bg-muted/40 border border-border/40">
          <div>
            <div class="text-xs font-medium text-muted-foreground">通用积分余额</div>
            <div class="text-2xl font-bold tracking-tight text-amber-500 mt-0.5 tabular-nums">
              {{ pointsData.generalPoints }}
            </div>
            <div v-if="pointsData.willExpirePoints > 0" class="text-[11px] text-muted-foreground mt-0.5">
              {{ pointsData.willExpirePoints }} 分将于 {{ pointsData.expireDate?.split(' ')[0] }} 到期
            </div>
          </div>
          <div>
            <div class="text-xs font-medium text-muted-foreground">云手机专属积分</div>
            <div class="text-2xl font-bold tracking-tight text-foreground mt-0.5 tabular-nums">
              {{ pointsData.phonePoints }}
            </div>
          </div>
        </div>

        <!-- 今日三大任务明细 -->
        <div class="space-y-2">
          <div class="text-xs font-medium text-foreground flex items-center justify-between">
            <span>今日任务明细 (每日最高 300 积分)</span>
          </div>

          <div
            v-for="task in pointsData.tasks"
            :key="task.name"
            class="p-3 rounded-xl border border-border/40 bg-card space-y-1.5 shadow-2xs"
          >
            <div class="flex items-center justify-between text-xs">
              <div class="flex items-center gap-1.5 font-medium text-foreground">
                <CheckCircle2 v-if="task.isCompleted" class="size-3.5 text-emerald-500 shrink-0" />
                <Clock v-else class="size-3.5 text-muted-foreground shrink-0" />
                <span>{{ task.name }}</span>
              </div>
              <Badge
                variant="secondary"
                class="h-5 px-1.5 text-[10px]"
                :class="task.isCompleted ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20' : 'bg-muted text-muted-foreground'"
              >
                {{ task.isCompleted ? '已完成' : '进行中' }} (+{{ task.rewardPoints }}分)
              </Badge>
            </div>

            <!-- 进度显示与单项手动执行控制 -->
            <div class="text-[11px] text-muted-foreground flex items-center justify-between font-mono pt-1">
              <span>{{ task.name.includes('使用') ? `已累计挂机: ${Math.floor(task.currentProgress / 60)} / ${Math.floor(task.totalProgress / 60)} 分钟 (${task.currentProgress}/${task.totalProgress}秒)` : `完成度: ${task.currentProgress} / ${task.totalProgress}` }}</span>
              <div class="flex items-center gap-2">
                <!-- 1. 使用1小时任务：智能补足时长 -->
                <template v-if="task.name.includes('使用')">
                  <Button
                    v-if="!task.isCompleted && task.currentProgress < (task.totalProgress - 5)"
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-[10px] gap-1 cursor-pointer border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                    :disabled="hangRunning"
                    @click="runHangInModal"
                    title="立即启动智能挂机，自动补齐剩余时长"
                  >
                    <Play class="size-2.5 fill-current" />
                    {{ hangRunning ? '智能补时中...' : '立即补足时长' }}
                  </Button>
                  <span v-else class="text-emerald-500 font-sans">
                    已达标
                  </span>
                </template>

                <!-- 2. 登录AI云电脑任务：手动执行 -->
                <template v-else-if="task.name.includes('登录')">
                  <Button
                    v-if="!task.isCompleted"
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-[10px] gap-1 cursor-pointer border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                    :disabled="loginRunning"
                    @click="runLoginTaskInModal"
                    title="手动执行登录AI云电脑任务"
                  >
                    <Play class="size-2.5 fill-current" />
                    {{ loginRunning ? '执行中...' : '手动执行' }}
                  </Button>
                  <span v-else class="text-emerald-500 font-sans">
                    已完成
                  </span>
                </template>

                <!-- 3. 与AI对话任务：手动执行 -->
                <template v-else-if="task.name.includes('对话') || task.name.includes('AI')">
                  <Button
                    v-if="!task.isCompleted"
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-[10px] gap-1 cursor-pointer border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                    :disabled="chatRunning"
                    @click="runAiChatTaskInModal"
                    title="手动执行与AI对话任务"
                  >
                    <Play class="size-2.5 fill-current" />
                    {{ chatRunning ? '执行中...' : '手动执行' }}
                  </Button>
                  <span v-else class="text-emerald-500 font-sans">
                    已完成
                  </span>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="py-8 text-center text-xs text-muted-foreground">
        未能获取到该账号的积分数据，请确认账号状态是否正常
      </div>

      <template #footer>
        <div class="flex items-center justify-end w-full">
          <Button class="w-24 h-9 shadow-xs cursor-pointer" @click="showPointsModal = false">
            关闭
          </Button>
        </div>
      </template>
    </AppDialog>
  </div>
</template>
