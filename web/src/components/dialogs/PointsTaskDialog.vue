<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useAppStore } from '@/stores/app';
import {
  CheckCircle2,
  Clock,
  Play,
  Gift,
  History,
  RefreshCw,
} from 'lucide-vue-next';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { AppDialog } from '@/shared/ui/dialog';

const props = defineProps<{
  open: boolean;
  accountName: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void;
}>();

const store = useAppStore();
const loading = ref(false);
const chatRunning = ref(false);
const claimRunning = ref(false);
const activeTab = ref<'tasks' | 'detail'>('tasks');

interface TaskPointItem {
  type: number;
  typeDesc: string;
  value: number;
}

interface TaskItem {
  taskDefId: number;
  type: string;
  name: string;
  desc: string;
  calendarType: number;
  status: number;
  statusText: string;
  isCompleted: boolean;
  canClaim: boolean;
  rewardPoints: number;
  points: TaskPointItem[];
  currentProgress: number;
  totalProgress: number;
}

interface PointsData {
  generalPoints: number;
  phonePoints: number;
  willExpirePoints: number;
  expireDate?: string;
  pointList: Array<{ pointType: number; pointTypeName?: string; points: number; totalPoints: number }>;
  tasks: TaskItem[];
}

interface PointDetailItem {
  msgType: number;
  pointsList: TaskPointItem[];
  createTime?: string;
  remark?: string;
}

interface DetailCache {
  list: PointDetailItem[];
  hasMore: boolean;
  page: number;
  filter: string;
}

// 模块级内存缓存：重开弹窗秒显，后台静默刷新
const pointsCache = new Map<string, PointsData>();
const detailCache = new Map<string, DetailCache>();

const pointsData = ref<PointsData | null>(null);
const detailList = ref<PointDetailItem[]>([]);
const detailLoading = ref(false);
const detailNoMore = ref(false);
const detailPage = ref(1);
const detailFilter = ref<'' | '1' | '2' | '3'>('');

async function loadPoints(force = false) {
  if (!props.accountName) return;
  const cached = pointsCache.get(props.accountName);
  if (cached && !force) {
    pointsData.value = cached;
    loading.value = false;
  } else if (!cached) {
    loading.value = true;
  }
  try {
    const data = await store.fetchPointsAndTasks(props.accountName);
    pointsData.value = data;
    pointsCache.set(props.accountName, data);
  } catch {
    if (!cached) pointsData.value = null;
  } finally {
    loading.value = false;
  }
}

async function fetchDetailPage(pageNum: number, reset: boolean) {
  const res = await store.fetchPointDetailList(props.accountName, {
    pageNum,
    pageSize: 10,
    msgType: detailFilter.value ? Number(detailFilter.value) : undefined,
  });
  if (reset) {
    detailList.value = res.list || [];
  } else {
    detailList.value = [...detailList.value, ...(res.list || [])];
  }
  detailNoMore.value = !res.hasMore;
  detailPage.value = reset ? 2 : pageNum + 1;
  detailCache.set(props.accountName, {
    list: detailList.value,
    hasMore: res.hasMore,
    page: detailPage.value,
    filter: detailFilter.value,
  });
}

async function loadDetail(reset = false) {
  if (!props.accountName || detailLoading.value) return;

  if (reset) {
    const cached = detailCache.get(props.accountName);
    // 仅当筛选条件一致时复用缓存，避免显示旧筛选结果
    if (cached && cached.filter === detailFilter.value && cached.list.length > 0) {
      detailList.value = cached.list;
      detailNoMore.value = !cached.hasMore;
      detailPage.value = cached.page;
      return;
    }
    detailPage.value = 1;
    detailList.value = [];
    detailNoMore.value = false;
  }
  if (detailNoMore.value) return;

  detailLoading.value = true;
  try {
    await fetchDetailPage(detailPage.value, reset);
  } catch {
    if (!detailList.value.length) detailNoMore.value = true;
  } finally {
    detailLoading.value = false;
  }
}

watch(
  () => props.open,
  (val) => {
    if (val) {
      activeTab.value = 'tasks';
      // 打开弹窗即并行预取积分与明细，切换 Tab 零等待
      loadPoints();
      loadDetail(true);
    }
  },
);

let filterTimer: ReturnType<typeof setTimeout> | null = null;
watch(detailFilter, () => {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => loadDetail(true), 150);
});

/** 平台任务 = 含通用(1)/专属(10)积分的任务；九江(20)积分的任务/明细不展示 */
const displayTasks = computed(() => {
  const list = pointsData.value?.tasks || [];
  return list
    .filter((t) => t.points.some((p) => p.type === 1 || p.type === 10))
    .map((t) => {
      const platformPoints = t.points.filter((p) => p.type === 1 || p.type === 10);
      return {
        ...t,
        rewardPoints: platformPoints.reduce((sum, p) => sum + (Number(p.value) || 0), 0),
      };
    });
});

/** 对齐官方分组：平台任务(通用1) 与 专属任务(专属10) */
const groupedTasks = computed(() => {
  const general = displayTasks.value.filter((t) => t.points.some((p) => p.type === 1));
  const exclusive = displayTasks.value.filter(
    (t) => !t.points.some((p) => p.type === 1) && t.points.some((p) => p.type === 10),
  );
  const groups: Array<{ key: string; title: string; tasks: typeof displayTasks.value }> = [];
  if (general.length > 0) groups.push({ key: 'platform', title: '平台任务', tasks: general });
  if (exclusive.length > 0) groups.push({ key: 'exclusive', title: '专属任务', tasks: exclusive });
  return groups;
});

const hasClaimable = computed(() => {
  return displayTasks.value.some((t) => t.status === 1);
});

async function runAiChatTaskInModal() {
  if (!props.accountName || chatRunning.value) return;
  chatRunning.value = true;
  try {
    await store.manualAiChatTask(props.accountName);
    await loadPoints();
  } finally {
    chatRunning.value = false;
  }
}

async function claimPendingTasks() {
  if (!props.accountName || claimRunning.value) return;
  claimRunning.value = true;
  try {
    await store.manualClaimTasks(props.accountName);
    await loadPoints();
  } finally {
    claimRunning.value = false;
  }
}

function formatProgress(task: TaskItem): string {
  if (task.type === 'hang') {
    const cur = Math.floor(task.currentProgress / 3600 * 10) / 10;
    return `已累计使用: ${cur} 小时`;
  }
  if (task.taskDefId === 1104) {
    return `已连续登录: ${task.currentProgress} 天`;
  }
  if (task.currentProgress > 0) {
    return `当前进度: ${task.currentProgress}`;
  }
  return '后台保活与任务自动累计';
}

function formatDetailPoints(item: PointDetailItem): string {
  const sum = (item.pointsList || []).reduce((acc, p) => acc + (Number(p.value) || 0), 0);
  const prefix = item.msgType === 1 ? '+' : '-';
  return `${prefix}${Math.abs(sum)}`;
}

function detailTypeLabel(msgType: number): string {
  if (msgType === 1) return '积分收入';
  if (msgType === 2) return '积分消耗';
  if (msgType === 3) return '积分过期';
  return '积分变动';
}
</script>

<template>
  <AppDialog
    :open="open"
    @update:open="emit('update:open', $event)"
    title="积分与今日任务"
    :description="`账号 [${accountName}] 当前可用积分与每日任务进度`"
    content-class="sm:max-w-md"
  >
    <div v-if="loading && !pointsData" class="py-10 text-center text-xs text-muted-foreground">
      正在拉取天翼云最新积分与每日任务进度...
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

      <!-- 积分类型明细 (通用/专属等，九江积分不展示) -->
      <div
        v-if="pointsData.pointList && pointsData.pointList.filter(p => p.pointType !== 20).length > 0"
        class="flex flex-wrap gap-1.5"
      >
        <Badge
          v-for="p in pointsData.pointList.filter(p => p.pointType !== 20)"
          :key="p.pointType"
          variant="secondary"
          class="h-5 px-2 text-[10px] bg-muted/60"
        >
          {{ p.pointTypeName || '积分' }}: {{ p.totalPoints }}
        </Badge>
      </div>

      <!-- Tab 切换 + 刷新 -->
      <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1 p-0.5 rounded-lg bg-muted/50 w-fit">
        <button
          class="px-3 h-7 text-xs rounded-md transition-colors cursor-pointer"
          :class="activeTab === 'tasks' ? 'bg-background text-foreground shadow-xs font-medium' : 'text-muted-foreground hover:text-foreground'"
          @click="activeTab = 'tasks'"
        >
          任务明细
        </button>
        <button
          class="px-3 h-7 text-xs rounded-md transition-colors cursor-pointer flex items-center gap-1"
          :class="activeTab === 'detail' ? 'bg-background text-foreground shadow-xs font-medium' : 'text-muted-foreground hover:text-foreground'"
          @click="activeTab = 'detail'"
        >
          <History class="size-3" />
          积分明细
        </button>
      </div>
        <Button
          variant="ghost"
          size="sm"
          class="h-7 px-2 text-[10px] gap-1 cursor-pointer text-muted-foreground hover:text-foreground"
          :disabled="loading || detailLoading"
          title="刷新积分与任务数据"
          @click="loadPoints(true); loadDetail(true);"
        >
          <RefreshCw class="size-3" :class="{ 'animate-spin': loading || detailLoading }" />
          刷新
        </Button>
      </div>

      <!-- 任务明细 -->
      <div v-if="activeTab === 'tasks'" class="space-y-2">
        <div class="text-xs font-medium text-foreground flex items-center justify-between">
          <span>今日任务</span>
          <Button
            v-if="hasClaimable"
            variant="outline"
            size="sm"
            class="h-6 px-2 text-[10px] gap-1 cursor-pointer border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
            :disabled="claimRunning"
            @click="claimPendingTasks"
          >
            <Gift class="size-2.5" />
            {{ claimRunning ? '领取中...' : '一键领取待领取奖励' }}
          </Button>
        </div>

        <template v-for="group in groupedTasks" :key="group.key">
          <div class="text-[11px] font-medium text-muted-foreground pt-1">{{ group.title }}</div>
          <div
            v-for="task in group.tasks"
            :key="task.taskDefId"
            class="p-3 rounded-xl border border-border/40 bg-card space-y-1.5 shadow-2xs"
          >
          <div class="flex items-center justify-between text-xs">
            <div class="flex items-center gap-1.5 font-medium text-foreground">
              <CheckCircle2 v-if="task.status === 2" class="size-3.5 text-emerald-500 shrink-0" />
              <Gift v-else-if="task.status === 1" class="size-3.5 text-amber-500 shrink-0" />
              <Clock v-else class="size-3.5 text-muted-foreground shrink-0" />
              <span>{{ task.name }}</span>
            </div>
            <Badge
              variant="secondary"
              class="h-5 px-1.5 text-[10px]"
              :class="
                task.status === 2
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                  : task.status === 1
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                    : 'bg-muted text-muted-foreground'
              "
            >
              {{ task.statusText }} (+{{ task.rewardPoints }}分)
            </Badge>
          </div>

          <!-- 进度显示与单项手动执行控制 -->
          <div class="text-[11px] text-muted-foreground flex items-center justify-between font-mono pt-1">
            <span>{{ formatProgress(task) }}</span>
            <div class="flex items-center gap-2">
              <!-- 1. 待领取任务：一键领取 -->
              <template v-if="task.status === 1">
                <Button
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[10px] gap-1 cursor-pointer border-amber-500/40 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                  :disabled="claimRunning"
                  @click="claimPendingTasks"
                >
                  <Gift class="size-2.5" />
                  领取奖励
                </Button>
              </template>

              <!-- 2. 挂机与登录类任务：提示保活自动达成 -->
              <template v-else-if="task.type === 'hang' || task.type === 'login'">
                <span v-if="task.status === 2" class="text-emerald-500 font-sans">已达标</span>
                <span v-else class="text-muted-foreground font-sans">后台保活长连自动累计</span>
              </template>

              <!-- 3. 与AI对话任务：手动执行 -->
              <template v-else-if="task.type === 'chat'">
                <Button
                  v-if="task.status !== 2"
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
                <span v-else class="text-emerald-500 font-sans">已领取</span>
              </template>

              <!-- 4. 其他任务 -->
              <template v-else>
                <span v-if="task.status === 2" class="text-emerald-500 font-sans">已领取</span>
                <span v-else class="text-muted-foreground font-sans">按官方规则完成</span>
              </template>
            </div>
          </div>
          </div>
        </template>

        <div
          v-if="displayTasks.length === 0"
          class="py-4 text-center text-xs text-muted-foreground"
        >
          暂未获取到官方任务列表
        </div>
      </div>

      <!-- 积分明细 -->
      <div v-else class="space-y-2">
        <div class="flex items-center gap-1.5">
          <button
            v-for="opt in [
              { label: '全部', value: '' as const },
              { label: '收入', value: '1' as const },
              { label: '消耗', value: '2' as const },
              { label: '过期', value: '3' as const },
            ]"
            :key="opt.value"
            class="px-2.5 h-6 text-[10px] rounded-full border transition-colors cursor-pointer"
            :class="detailFilter === opt.value ? 'bg-foreground text-background border-foreground' : 'border-border/60 text-muted-foreground hover:text-foreground'"
            @click="detailFilter = opt.value"
          >
            {{ opt.label }}
          </button>
        </div>

        <div class="space-y-1.5">
          <div
            v-for="(item, idx) in detailList"
            :key="idx"
            class="flex items-center justify-between px-3 py-2 rounded-lg border border-border/40 bg-card text-xs"
          >
            <div class="min-w-0">
              <div class="font-medium text-foreground truncate">
                {{ item.remark || detailTypeLabel(item.msgType) }}
              </div>
              <div class="text-[10px] text-muted-foreground mt-0.5">
                {{ item.createTime || '' }}
              </div>
            </div>
            <div
              class="font-mono tabular-nums font-semibold shrink-0 ml-2"
              :class="item.msgType === 1 ? 'text-emerald-500' : 'text-muted-foreground'"
            >
              {{ formatDetailPoints(item) }}
            </div>
          </div>
        </div>

        <div v-if="detailLoading && detailList.length === 0" class="py-6 text-center text-xs text-muted-foreground">
          正在加载积分明细...
        </div>

        <div v-else-if="detailList.length === 0" class="py-6 text-center text-xs text-muted-foreground">
          暂无积分明细记录
        </div>

        <div v-if="detailList.length > 0 && !detailNoMore" class="pt-1">
          <Button
            variant="outline"
            size="sm"
            class="w-full h-8 text-xs cursor-pointer"
            :disabled="detailLoading"
            @click="loadDetail()"
          >
            {{ detailLoading ? '加载中...' : '加载更多' }}
          </Button>
        </div>
      </div>
    </div>

    <div v-else class="py-8 text-center text-xs text-muted-foreground">
      未能获取到该账号的积分数据，请确认账号状态是否正常
    </div>

    <template #footer>
      <div class="flex items-center justify-end w-full">
        <Button class="w-24 h-9 shadow-xs cursor-pointer" @click="emit('update:open', false)">
          关闭
        </Button>
      </div>
    </template>
  </AppDialog>
</template>
