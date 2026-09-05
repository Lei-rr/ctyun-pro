<script setup lang="ts">
import { ref } from 'vue';
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

function parseDesktopSpec(desktop: any): string {
  const flavor = desktop.flavorName || '';
  const specMatch = flavor.match(/(\d+C\d+G)/i) || (desktop.desktopName || '').match(/(\d+C\d+G)/i);
  let spec = specMatch ? specMatch[1].toUpperCase() : '';

  if (!spec) {
    if (desktop.desktopName && desktop.desktopName.includes('尊享版')) spec = '8C16G';
    else if (desktop.desktopName && desktop.desktopName.includes('旗舰版')) spec = '16C32G';
    else spec = '4C8G';
  }

  return spec;
}
</script>

<template>
  <div class="flex flex-1 flex-col gap-6">
    <!-- 1. 统计指标卡片 (完全对齐 dns-pro Dashboard 样式：bg-muted/40 hover:bg-muted/60 transition-colors rounded-xl px-4 py-3) -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
          v-if="store.totalAccounts > 0"
          variant="outline"
          size="sm"
          class="gap-1.5 cursor-pointer shadow-xs border-border/60"
          @click="store.triggerAll('start')"
        >
          <Play class="size-3.5 fill-current text-emerald-500" />
          全部保活
        </Button>
        <Button
          v-if="store.totalAccounts > 0"
          variant="outline"
          size="sm"
          class="gap-1.5 cursor-pointer shadow-xs border-border/60"
          @click="store.triggerAll('stop')"
        >
          <Square class="size-3.5 fill-current text-muted-foreground" />
          全部停止
        </Button>
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
                  class="h-5 shrink-0 px-2 text-[11px] font-normal"
                  :class="{
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': account.status === 'online',
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': account.status === 'login_needed' || account.status === 'need_sms',
                    'bg-destructive/10 text-destructive border border-destructive/20': account.status === 'error',
                  }"
                >
                  {{ account.status === 'online' ? '保活中' : account.status === 'idle' ? '就绪' : account.status === 'error' ? '异常' : '需认证' }}
                </Badge>
                 <Badge v-if="account.redeemConfig?.enabled" variant="outline" class="h-5 shrink-0 px-2 text-[11px] font-normal border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                   自动兑换
                 </Badge>
                 <Badge v-if="account.taskConfig?.enabled" variant="outline" class="h-5 shrink-0 px-2 text-[11px] font-normal border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                   每日任务 ({{ account.taskConfig?.scheduleTime || '08:00' }})
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
                         v-if="desktop.useStatusText === '运行中' && desktop.status === 'connected'"
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
                <TableRow v-for="desktop in account.desktops" :key="desktop.desktopId" class="border-border/30 hover:bg-muted/30 transition-colors">
                  <TableCell class="py-2.5 font-medium text-foreground truncate">
                    <div class="flex items-center gap-2 min-w-0">
                      <Monitor class="size-4 text-muted-foreground shrink-0" />
                      <span class="truncate" :title="desktop.desktopName">{{ desktop.desktopName || '云电脑' }}</span>
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
                        'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': desktop.useStatusText === '运行中' || desktop.status === 'connected',
                        'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': desktop.useStatusText !== '运行中' && desktop.status === 'connecting',
                        'bg-muted text-muted-foreground': desktop.useStatusText !== '运行中' && desktop.status !== 'connected' && desktop.status !== 'connecting',
                      }"
                    >
                      {{ desktop.status === 'connected' ? '运行中' : (desktop.status === 'connecting' && desktop.useStatusText === '已关机' ? '开机就绪中' : (desktop.useStatusText || '已关机')) }}
                    </Badge>
                  </TableCell>
                  <TableCell class="py-2.5 whitespace-nowrap">
                    <div class="flex items-center gap-1.5 text-xs font-medium">
                      <span
                        class="size-2 rounded-full shrink-0"
                        :class="desktop.status === 'connected' ? 'bg-emerald-500 animate-pulse' : desktop.status === 'connecting' ? 'bg-amber-400 animate-ping' : 'bg-muted-foreground/30'"
                      ></span>
                      <span :class="desktop.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'" class="truncate">
                         {{ desktop.status === 'connected' ? '在线' : desktop.status === 'connecting' ? '正在连接' : '未连接' }}
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
                    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20': desktop.useStatusText === '运行中' || desktop.status === 'connected',
                    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20': desktop.useStatusText !== '运行中' && desktop.status === 'connecting',
                    'bg-muted text-muted-foreground': desktop.useStatusText !== '运行中' && desktop.status !== 'connected' && desktop.status !== 'connecting',
                  }"
                >
                  {{ desktop.status === 'connected' ? '运行中' : (desktop.status === 'connecting' && desktop.useStatusText === '已关机' ? '开机就绪中' : (desktop.useStatusText || '已关机')) }}
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
                    :class="desktop.status === 'connected' ? 'bg-emerald-500 animate-pulse' : desktop.status === 'connecting' ? 'bg-amber-400 animate-ping' : 'bg-muted-foreground/30'"
                  ></span>
                  <span :class="desktop.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'">
                     {{ desktop.status === 'connected' ? '在线' : desktop.status === 'connecting' ? '正在连接' : '未连接' }}
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
            <span class="text-muted-foreground">满 300 积分即可月换 8C16G</span>
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

            <!-- 进度显示 -->
            <div class="text-[11px] text-muted-foreground flex items-center justify-between font-mono pt-1">
              <span>{{ task.name === '使用1小时' ? `已累计挂机: ${Math.floor(task.currentProgress / 60)} / 60 分钟 (${task.currentProgress}/3600秒)` : `完成度: ${task.currentProgress} / ${task.totalProgress}` }}</span>
               <span v-if="task.name === '使用1小时' && task.isCompleted" class="text-emerald-500 font-sans">已达标</span>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="py-8 text-center text-xs text-muted-foreground">
        未能获取到该账号的积分数据，请确认账号状态是否正常
      </div>

      <template #footer>
        <div class="flex items-center gap-2.5 w-full">
          <Button
            variant="outline"
            class="flex-1 h-9 cursor-pointer gap-1.5"
            :disabled="taskRunning"
            @click="runTaskInModal"
          >
            <Zap class="size-4 text-emerald-500 fill-emerald-500/20" />
            {{ taskRunning ? '正在执行任务...' : '一键做任务' }}
          </Button>
          <Button class="flex-1 h-9 shadow-xs cursor-pointer" @click="showPointsModal = false">
            关闭
          </Button>
        </div>
      </template>
    </AppDialog>
  </div>
</template>
