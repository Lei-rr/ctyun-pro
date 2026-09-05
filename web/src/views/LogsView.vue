<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Switch } from '@/shared/ui/switch';
import { Terminal, RotateCcw } from 'lucide-vue-next';

const store = useAppStore();
const logBox = ref<HTMLDivElement | null>(null);

let es: EventSource | null = null;

function scrollToBottom() {
  if (store.autoScroll) {
    nextTick(() => {
      if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
    });
  }
}

watch(
  () => [store.logs.length, store.logs[store.logs.length - 1]?.count],
  () => {
    scrollToBottom();
  },
);

watch(
  () => store.autoScroll,
  (val) => {
    if (val) scrollToBottom();
  },
);

onMounted(() => {
  scrollToBottom();
  // 若 WS 尚未连上，开启 SSE 兜底推流
  if (!store.isWsConnected) {
    const url = store.adminToken
      ? `/api/logs/stream?token=${encodeURIComponent(store.adminToken)}`
      : '/api/logs/stream';
    es = new EventSource(url);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'init') {
           store.logs = (data.logs || []).slice(-200);
        } else if (data.type === 'log') {
          const incoming = data.log;
          const last = store.logs[store.logs.length - 1];
          if (last && (last.id === incoming.id || (last.message === incoming.message && last.level === incoming.level))) {
            last.count = incoming.count || (last.count || 1) + 1;
            last.time = incoming.time;
          } else {
            store.logs.push(incoming);
             if (store.logs.length > 200) store.logs.splice(0, store.logs.length - 200);
          }
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
        <span class="font-medium text-foreground">
          {{ store.isWsConnected ? 'WS 全双工实时推流已就绪' : '实时推流已就绪' }}
        </span>
        <span class="hidden sm:inline text-muted-foreground/60">·</span>
        <span class="hidden sm:inline">智能环形缓冲</span>
        <Badge variant="secondary" class="h-5 px-1.5 text-[10px] font-mono shrink-0 ml-1">
           {{ store.logs.length }} / 200 条
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

    <!-- 终端视窗 -->
    <div
      ref="logBox"
      class="h-[620px] w-full rounded-2xl bg-card border border-border/40 p-4 sm:p-5 font-mono text-xs overflow-y-auto space-y-1.5 shadow-2xs"
    >
      <div v-if="store.logs.length === 0" class="flex flex-col items-center justify-center h-full text-muted-foreground/60 gap-2">
        <Terminal class="size-8 stroke-[1.5] text-muted-foreground/40" />
        <p class="text-xs">暂无日志输出，启动保活或签到任务后将在此实时呈现</p>
      </div>

      <div
        v-for="log in store.logs"
        :key="log.id"
        class="leading-relaxed flex items-start gap-2.5 break-all select-text hover:bg-muted/30 px-1.5 py-0.5 rounded transition-colors"
      >
        <span class="text-muted-foreground/60 select-none shrink-0">[{{ log.time }}]</span>
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
            class="ml-1.5 inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-primary/10 text-primary border border-primary/20 select-none"
          >
            x{{ log.count }}
          </span>
        </span>
      </div>
    </div>
  </div>
</template>
