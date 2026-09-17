<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRoute, useRouter, RouterLink, RouterView } from 'vue-router';
import { useAppStore } from '@/stores/app';
import {
  Monitor,
  Moon,
  Sun,
  Server,
  Terminal,
  LogOut,
  Settings,
  Sparkles,
  ChevronDown,
  Settings2,
} from 'lucide-vue-next';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { AppTooltip, TooltipProvider } from '@/shared/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/shared/ui/dropdown-menu';
import { Toaster } from '@/shared/ui/sonner';
import { ConfirmHost } from '@/shared/ui/confirm';
import AddAccountDialog from '@/components/dialogs/AddAccountDialog.vue';
import PolicyConfigDialog from '@/components/dialogs/PolicyConfigDialog.vue';
import SystemConfigDialog from '@/components/dialogs/SystemConfigDialog.vue';

declare const __APP_VERSION__: string;
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v3.0.1';

const store = useAppStore();
const route = useRoute();
const router = useRouter();

// 全局设置弹窗
const showSystemModal = ref(false);

function openConfigModal() {
  showSystemModal.value = true;
}

async function handleLogout() {
  store.adminLogout();
  router.replace('/login');
}

// 当前移动端导航显示文本
const currentNavTitle = computed(() => {
  if (route.path === '/logs') return '实时日志';
  return '控制台';
});

let statusTimer: number | undefined;
onMounted(async () => {
  // 路由守卫 router.beforeEach 已经执行过 checkAuthStatus，此处无需重复调用
  if (store.needAuth && !store.isAuthenticated) {
    router.replace('/login');
    return;
  }
  await store.fetchStatus();
  store.connectWebSocket();
  // 30秒兜底心跳轮询
  statusTimer = window.setInterval(() => store.fetchStatus(), 30000);
});

onUnmounted(() => {
  if (statusTimer) window.clearInterval(statusTimer);
});
</script>

<template>
  <TooltipProvider>
    <!-- 独立全屏纯净推流播放页（无任何控制台顶栏与底栏） -->
    <div v-if="route.path.startsWith('/desktop/')" class="bg-black text-foreground min-h-svh w-screen overflow-hidden flex flex-col antialiased">
      <RouterView />
      <Toaster position="top-center" :close-button="true" />
    </div>

    <!-- 独立全屏登录页（无顶栏和底栏） -->
    <div v-else-if="route.path === '/login'" class="bg-background text-foreground min-h-svh flex flex-col antialiased">
      <RouterView />
      <Toaster position="top-center" :close-button="true" />
    </div>

    <!-- 主控制台布局 (带统一规范的顶栏与页脚) -->
    <div v-else class="bg-background text-foreground relative flex min-h-svh flex-col antialiased selection:bg-muted selection:text-foreground">
      <!-- 顶栏导航 -->
      <header class="bg-background/80 backdrop-blur-md sticky top-0 z-50 w-full border-b border-border/40">
        <div class="mx-auto flex h-14 w-full max-w-6xl min-w-0 items-center gap-2 px-4 sm:h-16 sm:px-6 lg:px-8">
          <!-- Logo 区域 -->
          <RouterLink to="/" class="mr-2 flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span class="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md text-sm font-bold shadow-xs">
              C
            </span>
            <span class="hidden sm:inline">CTYUN-PRO</span>
          </RouterLink>

          <!-- 桌面端常驻导航 (舒适大字号 text-[15px]，高度 h-9) -->
          <nav class="hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto lg:flex">
            <Button variant="ghost" as-child size="sm" class="h-9 shrink-0 px-3 text-[15px] cursor-pointer">
              <RouterLink to="/" :class="route.path === '/' && 'bg-accent text-accent-foreground font-medium'">
                控制台
              </RouterLink>
            </Button>
            <Button variant="ghost" as-child size="sm" class="h-9 shrink-0 px-3 text-[15px] cursor-pointer">
              <RouterLink to="/logs" :class="route.path === '/logs' && 'bg-accent text-accent-foreground font-medium'">
                实时日志
              </RouterLink>
            </Button>
          </nav>

          <!-- 手机端折叠导航 (解决文字溢出，当前模块下拉切换) -->
          <div class="min-w-0 flex-1 lg:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="sm" class="h-9 max-w-full gap-1 px-2 text-[15px] cursor-pointer">
                  <span class="truncate font-medium">{{ currentNavTitle }}</span>
                  <ChevronDown class="size-4 shrink-0 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" class="w-44">
                <DropdownMenuItem as-child>
                  <RouterLink to="/" class="w-full cursor-pointer" :class="route.path === '/' && 'bg-accent font-medium'">
                    控制台
                  </RouterLink>
                </DropdownMenuItem>
                <DropdownMenuItem as-child>
                  <RouterLink to="/logs" class="w-full cursor-pointer" :class="route.path === '/logs' && 'bg-accent font-medium'">
                    实时日志
                  </RouterLink>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <!-- 右侧工具栏 -->
          <div class="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <!-- 主题切换 -->
            <AppTooltip :content="store.isDark ? '切换为浅色模式' : '切换为深色模式'">
              <Button variant="ghost" size="icon" class="size-9 cursor-pointer" @click="store.toggleTheme()">
                <Sun v-if="store.isDark" class="size-4" />
                <Moon v-else class="size-4" />
              </Button>
            </AppTooltip>

            <!-- 更多设置下拉菜单 -->
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon" class="size-9 cursor-pointer" title="更多功能">
                  <Settings2 class="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-44">
                <DropdownMenuItem @select="openConfigModal" class="gap-2 cursor-pointer">
                  <Settings class="size-4" />
                  <span>系统设置</span>
                </DropdownMenuItem>
                <template v-if="store.needAuth">
                  <DropdownMenuSeparator />
                  <DropdownMenuItem @select="handleLogout" class="gap-2 text-destructive focus:text-destructive cursor-pointer">
                    <LogOut class="size-4" />
                    <span>退出登录</span>
                  </DropdownMenuItem>
                </template>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <!-- 主视图区 -->
      <main class="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <RouterView />
      </main>

      <!-- 统一规范底栏 -->
      <footer class="mt-auto border-t border-border/40 py-6 text-xs text-muted-foreground">
        <div class="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 sm:flex-row sm:px-6 lg:px-8">
          <div class="flex items-center gap-2">
            <span class="font-medium">CTYUN-PRO</span>
            <Badge variant="outline" class="h-4 px-1 text-[10px] border-border/60">
              {{ appVersion }}
            </Badge>
          </div>
          <div class="flex items-center gap-3">
            <span class="flex items-center gap-1.5">
              <span
                class="size-2 rounded-full inline-block"
                :class="store.isWsConnected ? 'bg-emerald-500' : 'bg-destructive'"
              ></span>
              <span class="font-mono text-[11px]">{{ store.isWsConnected ? '长连接正常' : '长连接重试中...' }}</span>
            </span>
          </div>
        </div>
      </footer>

      <!-- 业务弹窗解耦挂载 -->
      <AddAccountDialog />
      <PolicyConfigDialog />
      <SystemConfigDialog v-model:open="showSystemModal" />

      <!-- 全局 Toaster 消息通知 -->
      <Toaster position="top-center" :close-button="true" />
      <!-- 全局确认框宿主 -->
      <ConfirmHost />
    </div>
  </TooltipProvider>
</template>
