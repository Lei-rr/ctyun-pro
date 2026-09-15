<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/shared/ui/dropdown-menu';
import {
  LayoutDashboard,
  Terminal,
  RotateCcw,
  Sun,
  Moon,
  Laptop,
  Settings,
  Download,
  Upload,
  LogOut,
  ChevronRight,
  Menu,
  X,
} from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
const store = useAppStore();

const emit = defineEmits<{
  (e: 'open-system-config'): void;
}>();

const isMobileOpen = ref(false);

function toggleMobile() {
  isMobileOpen.value = !isMobileOpen.value;
}

function handleRefresh() {
  store.fetchAccounts();
  store.fetchLogs();
}

const themeIcon = computed(() => {
  if (store.themeMode === 'light') return Sun;
  if (store.themeMode === 'dark') return Moon;
  return Laptop;
});

function cycleTheme() {
  if (store.themeMode === 'dark') store.setThemeMode('light');
  else if (store.themeMode === 'light') store.setThemeMode('system');
  else store.setThemeMode('dark');
}

function handleExport() {
  store.exportProfiles();
}

function triggerImport() {
  const input = document.getElementById('profile-import-input') as HTMLInputElement;
  if (input) input.click();
}

function handleLogout() {
  store.logout();
}

function navigateTo(path: string) {
  router.push(path);
  isMobileOpen.value = false;
}
</script>

<template>
  <aside
    aria-label="快捷导航"
    class="fixed bottom-6 right-6 z-50 md:left-1/2 md:right-auto md:-translate-x-1/2"
  >
    <!-- 桌面端 Dock: 一比一对齐 WorkBuddy FloatingDockDesktop -->
    <div
      class="hidden md:flex items-center gap-2 h-16 px-4 pb-3 rounded-full bg-background/70 backdrop-blur-md border border-border/40 shadow-lg shadow-black/10 dark:shadow-white/5"
    >
      <!-- 控制台 -->
      <button
        type="button"
        @click="navigateTo('/')"
        class="group relative flex h-10 w-10 items-center justify-center rounded-full transition-all hover:bg-muted/80"
        :class="route.path === '/' ? 'bg-muted text-primary' : 'text-muted-foreground'"
        title="控制台"
      >
        <LayoutDashboard class="h-4 w-4 transition-transform group-hover:scale-110" />
        <span class="sr-only">控制台</span>
      </button>

      <!-- 实时日志 -->
      <button
        type="button"
        @click="navigateTo('/logs')"
        class="group relative flex h-10 w-10 items-center justify-center rounded-full transition-all hover:bg-muted/80"
        :class="route.path === '/logs' ? 'bg-muted text-primary' : 'text-muted-foreground'"
        title="实时日志"
      >
        <Terminal class="h-4 w-4 transition-transform group-hover:scale-110" />
        <span
          v-if="store.unreadLogs"
          class="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-background"
        />
        <span class="sr-only">实时日志</span>
      </button>

      <!-- 分隔线 (workbuddy divider) -->
      <div class="h-5 w-px bg-border/60 mx-0.5" />

      <!-- 刷新 -->
      <button
        type="button"
        @click="handleRefresh"
        class="group relative flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted/80 hover:text-foreground"
        title="刷新数据"
      >
        <RotateCcw class="h-4 w-4 transition-transform group-hover:rotate-180 duration-500" />
        <span class="sr-only">刷新</span>
      </button>

      <!-- 主题切换 -->
      <button
        type="button"
        @click="cycleTheme"
        class="group relative flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted/80 hover:text-foreground"
        :title="`当前主题: ${store.themeMode}`"
      >
        <component :is="themeIcon" class="h-4 w-4 transition-transform group-hover:scale-110" />
        <span class="sr-only">切换主题</span>
      </button>

      <!-- 更多运维操作下拉 -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="group relative flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-all hover:bg-muted/80 hover:text-foreground"
            title="更多操作"
          >
            <Settings class="h-4 w-4 transition-transform group-hover:rotate-90 duration-300" />
            <span class="sr-only">更多操作</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" class="w-48 mb-2 rounded-2xl p-1.5 bg-popover/90 backdrop-blur-md border-border/60 shadow-xl">
          <DropdownMenuItem @click="emit('open-system-config')" class="rounded-xl cursor-pointer text-xs py-2">
            <Settings class="mr-2 h-3.5 w-3.5" />
            系统配置
          </DropdownMenuItem>
          <DropdownMenuItem @click="handleExport" class="rounded-xl cursor-pointer text-xs py-2">
            <Download class="mr-2 h-3.5 w-3.5" />
            导出账号配置
          </DropdownMenuItem>
          <DropdownMenuItem @click="triggerImport" class="rounded-xl cursor-pointer text-xs py-2">
            <Upload class="mr-2 h-3.5 w-3.5" />
            导入账号配置
          </DropdownMenuItem>
          <DropdownMenuSeparator class="bg-border/50 my-1" />
          <DropdownMenuItem @click="handleLogout" class="rounded-xl cursor-pointer text-xs py-2 text-rose-500 focus:text-rose-500">
            <LogOut class="mr-2 h-3.5 w-3.5" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- 手机端 Dock: 一比一对齐 WorkBuddy FloatingDockMobile (折叠圆钮 + 弹出纵向胶囊) -->
    <div class="relative block md:hidden">
      <!-- 展开的菜单 -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="transform opacity-0 translate-y-2 scale-95"
        enter-to-class="transform opacity-100 translate-y-0 scale-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="transform opacity-100 translate-y-0 scale-100"
        leave-to-class="transform opacity-0 translate-y-2 scale-95"
      >
        <div
          v-if="isMobileOpen"
          class="absolute bottom-full right-0 mb-3 flex flex-col items-center gap-2 p-2 rounded-2xl bg-background/80 backdrop-blur-xl border border-border/50 shadow-2xl ring-1 ring-white/10"
        >
          <!-- 控制台 -->
          <button
            type="button"
            @click="navigateTo('/')"
            class="flex h-10 w-10 items-center justify-center rounded-full transition-colors"
            :class="route.path === '/' ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground'"
          >
            <LayoutDashboard class="h-4 w-4" />
          </button>

          <!-- 实时日志 -->
          <button
            type="button"
            @click="navigateTo('/logs')"
            class="relative flex h-10 w-10 items-center justify-center rounded-full transition-colors"
            :class="route.path === '/logs' ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground'"
          >
            <Terminal class="h-4 w-4" />
            <span
              v-if="store.unreadLogs"
              class="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-background"
            />
          </button>

          <!-- 刷新 -->
          <button
            type="button"
            @click="handleRefresh"
            class="flex h-10 w-10 items-center justify-center rounded-full bg-muted/60 text-foreground transition-colors hover:bg-muted"
          >
            <RotateCcw class="h-4 w-4" />
          </button>

          <!-- 系统配置 -->
          <button
            type="button"
            @click="emit('open-system-config'); isMobileOpen = false"
            class="flex h-10 w-10 items-center justify-center rounded-full bg-muted/60 text-foreground transition-colors hover:bg-muted"
          >
            <Settings class="h-4 w-4" />
          </button>

          <!-- 退出 -->
          <button
            type="button"
            @click="handleLogout"
            class="flex h-10 w-10 items-center justify-center rounded-full bg-rose-500/10 text-rose-500 transition-colors"
          >
            <LogOut class="h-4 w-4" />
          </button>
        </div>
      </Transition>

      <!-- 手机端常驻折叠圆钮 (对齐 WorkBuddy 48x48 悬浮毛玻璃球) -->
      <button
        type="button"
        @click="toggleMobile"
        class="flex h-12 w-12 items-center justify-center rounded-full bg-background/80 backdrop-blur-md border border-border/40 shadow-lg shadow-black/10 dark:shadow-white/5 text-foreground active:scale-95 transition-all"
        aria-label="切换菜单"
      >
        <Menu v-if="!isMobileOpen" class="h-5 w-5 transition-transform" />
        <X v-else class="h-5 w-5 transition-transform rotate-90" />
      </button>
    </div>
  </aside>
</template>
