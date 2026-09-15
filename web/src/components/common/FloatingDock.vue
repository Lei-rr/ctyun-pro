<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import {
  LayoutDashboard,
  Terminal,
  Sun,
  Moon,
  Monitor,
  Settings2,
  LogOut,
  RefreshCw,
  FolderSync,
  Download,
  Upload,
  MoreVertical,
} from 'lucide-vue-next';

defineProps<{
  theme: 'dark' | 'light' | 'system';
  unreadCount?: number;
}>();

const emit = defineEmits<{
  (e: 'set-theme', mode: 'dark' | 'light' | 'system'): void;
  (e: 'open-system-config'): void;
  (e: 'export-profiles'): void;
  (e: 'trigger-import'): void;
}>();

const route = useRoute();
const router = useRouter();
const store = useAppStore();

const navItems = [
  {
    path: '/',
    label: '控制台',
    icon: LayoutDashboard,
  },
  {
    path: '/logs',
    label: '实时日志',
    icon: Terminal,
  },
];

const isProfilesActive = computed(() => route.path === '/');
const isLogsActive = computed(() => route.path === '/logs');

function handleReloadAll() {
  store.fetchStatus();
}
</script>

<template>
  <!-- 底部固定容器 (WorkBuddy Floating Dock) -->
  <div class="fixed bottom-6 inset-x-0 mx-auto max-w-fit px-4 pointer-events-none z-50">
    <div class="pointer-events-auto flex items-center gap-1.5 p-2 rounded-full bg-background/80 backdrop-blur-xl border border-border/60 shadow-2xl transition-all">
      <!-- 页面导航项 -->
      <button
        v-for="item in navItems"
        :key="item.path"
        @click="router.push(item.path)"
        class="relative flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium transition-all duration-200 cursor-pointer select-none"
        :class="route.path === item.path ? 'bg-muted text-foreground shadow-2xs font-semibold' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'"
      >
        <component :is="item.icon" class="size-4 shrink-0" />
        <span>{{ item.label }}</span>
        <span
          v-if="item.path === '/logs' && unreadCount && unreadCount > 0"
          class="size-2 rounded-full bg-primary animate-pulse"
        ></span>
      </button>

      <!-- 分隔线 -->
      <div class="h-4 w-px bg-border/60 mx-1"></div>

      <!-- 快速刷新 -->
      <Button
        variant="ghost"
        size="icon"
        class="size-8.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/70 cursor-pointer"
        :title="store.loading ? '正在同步数据...' : '手动刷新数据'"
        @click="handleReloadAll"
      >
        <RefreshCw class="size-4" :class="{ 'animate-spin': store.loading }" />
      </Button>

      <!-- 主题切换 Dropdown -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="size-8.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/70 cursor-pointer"
            title="切换主题"
          >
            <Sun v-if="theme === 'light'" class="size-4" />
            <Moon v-else-if="theme === 'dark'" class="size-4" />
            <Monitor v-else class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" :side-offset="12" class="w-32 rounded-2xl p-1 shadow-xl backdrop-blur-xl bg-popover/90 border border-border/50">
          <DropdownMenuItem class="rounded-xl text-xs gap-2 cursor-pointer" @click="emit('set-theme', 'light')">
            <Sun class="size-3.5" />
            <span>浅色模式</span>
          </DropdownMenuItem>
          <DropdownMenuItem class="rounded-xl text-xs gap-2 cursor-pointer" @click="emit('set-theme', 'dark')">
            <Moon class="size-3.5" />
            <span>深色模式</span>
          </DropdownMenuItem>
          <DropdownMenuItem class="rounded-xl text-xs gap-2 cursor-pointer" @click="emit('set-theme', 'system')">
            <Monitor class="size-3.5" />
            <span>跟随系统</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- 更多设置与系统运维 Dropdown -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="size-8.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/70 cursor-pointer"
            title="更多选项与设置"
          >
            <MoreVertical class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" :side-offset="12" class="w-48 rounded-2xl p-1.5 shadow-xl backdrop-blur-xl bg-popover/90 border border-border/50">
          <DropdownMenuItem class="rounded-xl text-xs gap-2 cursor-pointer" @click="emit('open-system-config')">
            <Settings2 class="size-3.5 text-muted-foreground" />
            <span>系统设置与 Webhook</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator class="my-1 bg-border/40" />
          <DropdownMenuItem class="rounded-xl text-xs gap-2 cursor-pointer" @click="emit('export-profiles')">
            <Download class="size-3.5 text-muted-foreground" />
            <span>导出账号配置 (JSON)</span>
          </DropdownMenuItem>
          <DropdownMenuItem class="rounded-xl text-xs gap-2 cursor-pointer" @click="emit('trigger-import')">
            <Upload class="size-3.5 text-muted-foreground" />
            <span>导入账号配置 (JSON)</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator class="my-1 bg-border/40" />
          <DropdownMenuItem class="rounded-xl text-xs gap-2 cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10" @click="store.logout()">
            <LogOut class="size-3.5" />
            <span>退出管理会话</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
