<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import {
  CheckCircle2,
  Clock,
  Play,
  Square,
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
    type?: string;
  }>;
} | null>(null);

async function loadPoints() {
  if (!props.accountName) return;
  loading.value = true;
  try {
    pointsData.value = await store.fetchPointsAndTasks(props.accountName);
  } catch {
    pointsData.value = null;
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (val) => {
    if (val) {
      loadPoints();
    }
  },
);

async function runHangInModal() {
  if (!props.accountName || hangRunning.value) return;
  hangRunning.value = true;
  try {
    await store.manualActivateDesktop(props.accountName);
    emit('update:open', false);
  } finally {
    hangRunning.value = false;
  }
}

async function stopHangInModal() {
  if (!props.accountName) return;
  await store.manualStopHang(props.accountName);
  await loadPoints();
}

async function runLoginTaskInModal() {
  if (!props.accountName || loginRunning.value) return;
  loginRunning.value = true;
  try {
    await store.manualLoginDesktopTask(props.accountName);
    await loadPoints();
  } finally {
    loginRunning.value = false;
  }
}

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
</script>

<template>
  <AppDialog
    :open="open"
    @update:open="emit('update:open', $event)"
    title="积分与今日任务"
    :description="`账号 [${accountName}] 当前可用积分与每日三大任务进度`"
    content-class="sm:max-w-md"
  >
    <div v-if="loading" class="py-10 text-center text-xs text-muted-foreground">
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
            <span>{{ (task.type === 'hang' || task.name.includes('使用') || task.name.includes('时长') || task.name.includes('体验')) ? `已累计挂机: ${Math.floor(task.currentProgress / 60)} / ${Math.floor(task.totalProgress / 60)} 分钟 (${task.currentProgress}/${task.totalProgress}秒)` : `完成度: ${task.currentProgress} / ${task.totalProgress}` }}</span>
            <div class="flex items-center gap-2">
              <!-- 1. 挂机类任务：智能补足时长 / 中止挂机 -->
              <template v-if="task.type === 'hang' || task.name.includes('使用') || task.name.includes('时长') || task.name.includes('体验')">
                <Button
                  v-if="store.accounts.find((a) => a.name === accountName)?.hangStatus?.running"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[10px] gap-1 cursor-pointer border-destructive/40 text-destructive hover:bg-destructive/10"
                  @click="stopHangInModal"
                  title="立即中止挂机任务并恢复保活"
                >
                  <Square class="size-2.5 fill-current" />
                  中止挂机
                </Button>
                <Button
                  v-else-if="!task.isCompleted && task.currentProgress < (task.totalProgress - 5)"
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
        <Button class="w-24 h-9 shadow-xs cursor-pointer" @click="emit('update:open', false)">
          关闭
        </Button>
      </div>
    </template>
  </AppDialog>
</template>
