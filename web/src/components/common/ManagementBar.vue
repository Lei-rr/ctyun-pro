<script setup lang="ts">
import { ref, computed } from 'vue';
import { useAppStore } from '@/stores/app';
import { Input } from '@/shared/ui/input';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/shared/ui/dropdown-menu';
import {
  Search,
  Plus,
  Play,
  Square,
  RefreshCw,
  SlidersHorizontal,
  ChevronDown,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Monitor,
} from 'lucide-vue-next';

const props = defineProps<{
  searchQuery: string;
}>();

const emit = defineEmits<{
  (e: 'update:searchQuery', value: string): void;
  (e: 'open-add'): void;
}>();

const store = useAppStore();

const totalAccounts = computed(() => store.accounts.length);
const totalDesktops = computed(() => {
  return store.accounts.reduce((sum, acc) => sum + (acc.desktops?.length || 0), 0);
});
const activeDesktops = computed(() => {
  let count = 0;
  store.accounts.forEach((acc) => {
    acc.desktops?.forEach((d) => {
      const code = d.desktopCode || d.desktopId;
      const st = store.hangStatuses[code] || d.hangStatus;
      if (st && st.status === 'RUNNING') count++;
    });
  });
  return count;
});

function handleSearch(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  emit('update:searchQuery', val);
}

function handleBatchStart() {
  store.triggerAll('start');
}

function handleBatchStop() {
  store.triggerAll('stop');
}

function handleSyncAll() {
  store.fetchAccounts();
}
</script>

<template>
  <!-- WorkBuddy 风格顶部管理条: 极简纯净无边框 + 药丸搜索框 + 紧凑操作组 -->
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <!-- 搜索框 -->
    <div class="relative flex-1 max-w-sm">
      <Search class="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        :value="searchQuery"
        @input="handleSearch"
        placeholder="搜索账号备注、手机号或桌面..."
        class="h-9 pl-9 pr-4 rounded-full bg-muted/50 border-border/50 text-xs focus-visible:bg-background transition-all"
      />
    </div>

    <!-- 批量控制 & 快捷操作 -->
    <div class="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
      <!-- 批量保活下拉 -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="outline"
            size="sm"
            class="h-8 rounded-full text-xs font-normal border-border/60 bg-background/50 hover:bg-muted/80 gap-1.5"
            :disabled="store.batchActionLoading"
          >
            <Loader2 v-if="store.batchActionLoading" class="h-3.5 w-3.5 animate-spin" />
            <SlidersHorizontal v-else class="h-3.5 w-3.5 text-muted-foreground" />
            <span>批量控制</span>
            <ChevronDown class="h-3 w-3 text-muted-foreground opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-44 rounded-2xl p-1 bg-popover/90 backdrop-blur-md border-border/60 shadow-xl">
          <DropdownMenuItem @click="handleBatchStart" class="rounded-xl cursor-pointer text-xs py-2 text-emerald-500 focus:text-emerald-500 focus:bg-emerald-500/10">
            <Play class="mr-2 h-3.5 w-3.5" />
            全部开启保活
          </DropdownMenuItem>
          <DropdownMenuItem @click="handleBatchStop" class="rounded-xl cursor-pointer text-xs py-2 text-rose-500 focus:text-rose-500 focus:bg-rose-500/10">
            <Square class="mr-2 h-3.5 w-3.5" />
            全部停止保活
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- 同步刷新 -->
      <Button
        variant="outline"
        size="sm"
        @click="handleSyncAll"
        :disabled="store.loading"
        class="h-8 rounded-full text-xs font-normal border-border/60 bg-background/50 hover:bg-muted/80 gap-1.5"
        title="刷新全部云电脑状态"
      >
        <RefreshCw class="h-3.5 w-3.5 text-muted-foreground" :class="store.loading ? 'animate-spin' : ''" />
        <span class="hidden sm:inline">全量同步</span>
      </Button>

      <!-- 添加账号 -->
      <Button
        size="sm"
        @click="emit('open-add')"
        class="h-8 rounded-full text-xs bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5 shadow-sm shadow-primary/20"
      >
        <Plus class="h-3.5 w-3.5" />
        <span>添加账号</span>
      </Button>
    </div>
  </div>
</template>
