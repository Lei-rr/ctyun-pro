<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useAppStore, type LogSource } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Switch } from '@/shared/ui/switch';
import { Terminal, RotateCcw } from 'lucide-vue-next';

const store = useAppStore();
const logBox = ref<HTMLDivElement | null>(null);
const filterSource = ref<LogSource | 'all'>('all');

const SOURCE_LABEL: Record<LogSource, string> = {
  system: '系统',
  account: '账号',
  keepalive: '保活',
  watchdog: '探针',
  task: '任务',
  redeem: '兑换',
  power: '电源',
  proxy: '代理',
  api: '接口',
};

const SOURCE_CLASS: Record<LogSource, string> = {
  system: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30',
  account: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30',
  keepalive: 'bg-sky-500/15 text-sky-600 dark:text-sky-300 border-sky-500/30',
  watchdog: 'bg-teal-500/15 text-teal-600 dark:text-teal-300 border-teal-500/30',
  task: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border-indigo-500/30',
  redeem: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30',
  power: 'bg-orange-500/15 text-orange-600 dark:text-orange-300 border-orange-500/30',
  proxy: 'bg-pink-500/15 text-pink-600 dark:text-pink-300 border-pink-500/30',
  api: 'bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30',
};

const availableSources = computed(() => {
  const set = new Set<LogSource>();
  for (const l of store.logs) if (l.source) set.add(l.source);
  return Array.from(set);
});

const visibleLogs = computed(() =>
  filterSource.value === 'all' ? store.logs : store.logs.filter((l) => l.source === filterSource.value),
);

let es: EventSource | null = null;

function scrollToBottom() {
  if (store.autoScroll) {
    nextTick(() => {
      if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
    });
  }
}

watch(
  () => [store.logs.length, store.logs[store.logs.length - 1]?.count, filterSource.value],
  () => scrollToBottom(),
);

watch(
  () => store.autoScroll,
  (val) => {
    if (val) scrollToBottom();
  },
);

onMounted(() => {
  scrollToBottom();
  // WS 未连通时用 SSE 兜底 (同源 Cookie 鉴权)
  if (!store.isWsConnected) {
    es = new EventSource('/api/logs/stream');
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'init') {
          store.initLogs(data.logs);
        } else if (data.type === 'log') {
          store.appendLog(data.log);
        }
        scrollToBottom();
      } catch {}
    };
  }
});

onUnmounted(() => {
  if (es) es.close();
});
</script>

<template>
  <div class="flex flex-1 flex-col gap-4">
    <!-- 顶部状态与工具条 -->
    <div class="flex flex-col gap-3 min-[480px]:flex-row min-[480px]:items-center min-[480px]:justify-between">
      <div class="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
        <span class="relative flex size-2">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
        </span>
        <span class="font-medium text-foreground">实时日志</span>
        <Badge variant="secondary" class="h-5 px-1.5 text-[10px] font-mono shrink-0 ml-1">
          {{ store.logs.length }} / 1000 条
        </Badge>
      </div>

      <div class="flex items-center gap-3 self-end min-[480px]:self-auto">
        <div class="flex items-center gap-2">
          <label for="auto-scroll" class="text-xs text-muted-foreground cursor-pointer select-none">
            自动滚屏
          </label>
          <Switch id="auto-scroll" v-model="store.autoScroll" />
        </div>

        <Button
          variant="outline"
          size="sm"
          class="h-8 gap-1.5 text-xs cursor-pointer border-border/60"
          @click="store.clearLogs()"
        >
          <RotateCcw class="size-3.5" />
          清空日志
        </Button>
      </div>
    </div>

    <!-- 来源过滤 -->
    <div v-if="availableSources.length > 1" class="flex flex-wrap items-center gap-1.5">
      <button
        class="h-6 px-2 rounded-full border text-[10px] font-medium transition-colors cursor-pointer"
        :class="filterSource === 'all'
          ? 'bg-foreground text-background border-foreground'
          : 'bg-transparent text-muted-foreground border-border/60 hover:text-foreground hover:border-border'"
        @click="filterSource = 'all'"
      >
        全部
      </button>
      <button
        v-for="src in availableSources"
        :key="src"
        class="h-6 px-2 rounded-full border text-[10px] font-medium transition-colors cursor-pointer"
        :class="filterSource === src
          ? 'bg-foreground text-background border-foreground'
          : 'bg-transparent text-muted-foreground border-border/60 hover:text-foreground hover:border-border'"
        @click="filterSource = src"
      >
        {{ SOURCE_LABEL[src] || src }}
      </button>
    </div>

    <!-- 终端视窗 -->
    <div
      ref="logBox"
      class="h-[620px] w-full rounded-2xl bg-card border border-border/40 p-4 sm:p-5 font-mono text-xs overflow-y-auto space-y-1.5 shadow-2xs"
    >
      <div v-if="visibleLogs.length === 0" class="flex flex-col items-center justify-center h-full text-muted-foreground/60 gap-2">
        <Terminal class="size-8 stroke-[1.5] text-muted-foreground/40" />
        <p class="text-xs">暂无日志输出，启动保活或执行任务后将在此实时呈现</p>
      </div>

      <div
        v-for="log in visibleLogs"
        :key="log.id"
        class="leading-relaxed flex items-start gap-2 break-all select-text hover:bg-muted/30 px-1.5 py-0.5 rounded transition-colors"
      >
        <span class="text-muted-foreground/60 select-none shrink-0">[{{ log.time }}]</span>
        <span
          class="inline-flex items-center shrink-0 px-1.5 py-px rounded border text-[10px] font-medium select-none mt-px"
          :class="SOURCE_CLASS[log.source] || SOURCE_CLASS.system"
        >
          {{ SOURCE_LABEL[log.source] || '系统' }}
        </span>
        <span
          v-if="log.account"
          class="shrink-0 text-[10px] text-muted-foreground select-none mt-px max-w-[180px] truncate"
          :title="log.desktop ? `${log.account} - ${log.desktop}` : log.account"
        >
          {{ log.account }}<span v-if="log.desktop" class="text-muted-foreground/50">/{{ log.desktop }}</span>
        </span>
        <span
          class="flex-1"
          :class="{
            'text-emerald-600 dark:text-emerald-400': log.level === 'success',
            'text-foreground': log.level === 'info',
            'text-amber-600 dark:text-amber-400': log.level === 'warn',
            'text-rose-600 dark:text-rose-400 font-semibold': log.level === 'error',
          }"
        >
          {{ log.message }}
          <span
            v-if="log.count && log.count > 1"
            class="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-sky-500/15 text-sky-600 dark:bg-sky-400/20 dark:text-sky-300 border border-sky-500/30 select-none leading-none align-middle"
          >
            x{{ log.count }}
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
