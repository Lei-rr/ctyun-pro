<script setup lang="ts">
import { ref } from 'vue';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/shared/ui/dropdown-menu';
import {
  Search,
  Plus,
  Play,
  Square,
  Power,
  RefreshCw,
  Loader2,
  Gift,
  ChevronDown
} from 'lucide-vue-next';

const store = useAppStore();

const searchQuery = defineModel<string>('search', { default: '' });
const statusFilter = defineModel<string>('status', { default: 'all' });

const isBatchStarting = ref(false);
const isBatchStopping = ref(false);
const isBatchBooting = ref(false);

const emit = defineEmits<{
  (e: 'add-account'): void;
  (e: 'open-points-task'): void;
}>();

async function handleBatchStart() {
  isBatchStarting.value = true;
  try {
    await store.triggerAll('start');
  } finally {
    isBatchStarting.value = false;
  }
}

async function handleBatchStop() {
  isBatchStopping.value = true;
  try {
    await store.triggerAll('stop');
  } finally {
    isBatchStopping.value = false;
  }
}

async function handleBatchBoot() {
  isBatchBooting.value = true;
  try {
    await store.triggerAll('boot');
  } finally {
    isBatchBooting.value = false;
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-3 rounded-[20px] bg-muted/60 dark:bg-muted/40 backdrop-blur-sm border border-border/40 p-3 sm:p-4 mb-6"
  >
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <!-- 搜索框与筛选 -->
      <div class="flex items-center gap-2 flex-1 max-w-md">
        <div class="relative flex-1">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            v-model="searchQuery"
            placeholder="搜索账号或云电脑名称..."
            class="h-9 pl-9 pr-3 rounded-full bg-background/80 border-border/60 text-xs focus-visible:ring-1"
          />
        </div>
      </div>

      <!-- 快捷操作区 -->
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <!-- 批量操作下拉 -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              variant="outline"
              size="sm"
              class="h-8.5 rounded-full px-3.5 gap-1.5 text-xs font-medium border-border/60 bg-background/80 hover:bg-background cursor-pointer"
            >
              <span>批量控制</span>
              <ChevronDown class="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-40 rounded-xl">
            <DropdownMenuItem
              :disabled="isBatchStarting"
              class="gap-2 cursor-pointer"
              @click="handleBatchStart"
            >
              <Loader2 v-if="isBatchStarting" class="size-3.5 animate-spin" />
              <Play v-else class="size-3.5 text-emerald-500" />
              <span>一键启动保活</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              :disabled="isBatchStopping"
              class="gap-2 cursor-pointer"
              @click="handleBatchStop"
            >
              <Loader2 v-if="isBatchStopping" class="size-3.5 animate-spin" />
              <Square v-else class="size-3.5 text-amber-500" />
              <span>一键停止保活</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              :disabled="isBatchBooting"
              class="gap-2 cursor-pointer"
              @click="handleBatchBoot"
            >
              <Loader2 v-if="isBatchBooting" class="size-3.5 animate-spin" />
              <Power v-else class="size-3.5 text-blue-500" />
              <span>一键开机</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          size="sm"
          class="h-8.5 rounded-full px-3.5 gap-1.5 text-xs font-medium border-border/60 bg-background/80 hover:bg-background cursor-pointer"
          @click="emit('open-points-task')"
        >
          <Gift class="size-3.5 text-violet-500" />
          <span>兑换中心</span>
        </Button>

        <Button
          size="sm"
          class="h-8.5 rounded-full px-3.5 gap-1.5 text-xs font-medium bg-foreground text-background hover:bg-foreground/90 cursor-pointer shadow-xs"
          @click="emit('add-account')"
        >
          <Plus class="size-3.5" />
          <span>添加账号</span>
        </Button>
      </div>
    </div>
  </div>
</template>
