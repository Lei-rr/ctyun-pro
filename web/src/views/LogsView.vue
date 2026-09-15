<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Switch } from '@/shared/ui/switch';
import { Terminal, RotateCcw } from 'lucide-vue-next';
import PageHeader from '@/components/common/PageHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';

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
  <div class="flex flex-1 flex-col gap-6 pb-20 sm:pb-8">
    <!-- PageHeader 统一风格 -->
    <PageHeader
      title="实时日志"
      description="天翼云电脑 WebSocket 长连接心跳保活、AI对话任务与自动兑换流水"
    >
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2">
          <label for="auto-scroll" class="text-xs text-muted-foreground cursor-pointer select-none">
            自动滚屏
          </label>
          <Switch id="auto-scroll" v-model="store.autoScroll" />
        </div>

        <Button
          variant="outline"
          size="sm"
          class="h-8.5 rounded-full px-3.5 gap-1.5 text-xs cursor-pointer border-border/60 bg-background/80"
          @click="store.clearLogs()"
        >
          <RotateCcw class="size-3.5" />
          清空日志
        </Button>
      </div>
    </PageHeader>

    <!-- 终端卡片 (WorkBuddy 20px 圆角与暗黑极简边框) -->
    <div
      ref="logBox"
      class="h-[620px] w-full rounded-[20px] bg-card border border-border/50 p-4 sm:p-5 font-mono text-xs overflow-y-auto space-y-1.5 shadow-xs scroll-slim"
    >
      <EmptyState
        v-if="store.logs.length === 0"
        :icon="Terminal"
        title="暂无日志"
        description="启动保活或执行任务后将在此实时呈现系统运行输出"
        className="flex flex-col items-center justify-center h-full text-center py-12"
      />

      <div
        v-for="log in store.logs"
        :key="log.id"
        class="leading-relaxed flex items-start gap-2.5 break-all select-text hover:bg-muted/40 px-2 py-1 rounded-md transition-colors"
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
        </span>
        <Badge
          v-if="log.count && log.count > 1"
          variant="outline"
          class="text-[10px] font-mono h-4 px-1.5 rounded-full shrink-0 border-primary/30 text-primary bg-primary/5 select-none"
        >
          x{{ log.count }}
        </Badge>
      </div>
    </div>
  </div>
</template>
