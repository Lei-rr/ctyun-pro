<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { toast } from '@/shared/lib/toast';
import { Toaster } from '@/shared/ui/sonner';
import AddAccountDialog from '@/components/dialogs/AddAccountDialog.vue';
import PolicyConfigDialog from '@/components/dialogs/PolicyConfigDialog.vue';
import SystemConfigDialog from '@/components/dialogs/SystemConfigDialog.vue';
import FloatingDock from '@/components/common/FloatingDock.vue';
import { Button } from '@/shared/ui/button';
import { Badge } from '@/shared/ui/badge';
import { Cloud, ExternalLink } from 'lucide-vue-next';

const store = useAppStore();
const route = useRoute();

const fileInputRef = ref<HTMLInputElement | null>(null);
const showSystemModal = ref(false);

const appVersion = ref('v3.0.0');

// 主题状态：'dark' | 'light' | 'system'
const theme = ref<'dark' | 'light' | 'system'>('dark');

function applyTheme(mode: 'dark' | 'light' | 'system') {
  theme.value = mode;
  localStorage.setItem('theme', mode);

  if (mode === 'system') {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', isDark);
  } else {
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }
}

function initTheme() {
  const saved = localStorage.getItem('theme') as 'dark' | 'light' | 'system' | null;
  if (saved && ['dark', 'light', 'system'].includes(saved)) {
    applyTheme(saved);
  } else {
    // 默认保持 dark 现代暗黑极简质感
    applyTheme('dark');
  }
}

async function exportProfiles() {
  try {
    const res = await fetch('/api/profiles/export', {
      headers: {
        ...(store.adminToken ? { 'x-admin-token': store.adminToken } : {}),
      },
    });
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ctyun-profiles-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    toast.success('账号配置导出成功');
  } catch (e: any) {
    toast.error(e.message || '导出失败');
  }
}

function triggerImport() {
  fileInputRef.value?.click();
}

async function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const res = await fetch('/api/profiles/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(store.adminToken ? { 'x-admin-token': store.adminToken } : {}),
      },
      body: JSON.stringify(json),
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.msg || '导入失败');
    toast.success(`成功导入 ${result.count || 0} 个账号配置`);
    store.fetchStatus();
  } catch (e: any) {
    toast.error(e.message || '导入格式错误');
  } finally {
    target.value = '';
  }
}

onMounted(() => {
  initTheme();
  store.init();

  fetch('/api/health')
    .then((res) => res.json())
    .then((data) => {
      if (data?.version) {
        appVersion.value = data.version.startsWith('v') ? data.version : `v${data.version}`;
      }
    })
    .catch(() => {});
});
</script>

<template>
  <Toaster position="top-right" :rich-colors="true" />

  <!-- 隐藏的文件导入 input -->
  <input
    type="file"
    ref="fileInputRef"
    style="display: none"
    accept=".json"
    @change="handleFileChange"
  />

  <!-- 独立全屏视图 (如远程桌面直连 /desktop/:desktopCode 与 登录页 /login) -->
  <template v-if="route.path.startsWith('/desktop/') || route.path === '/login'">
    <RouterView />
  </template>

  <!-- 主布局 (WorkBuddy / LINUX DO 极简居中 + 底部 Floating Dock 布局) -->
  <div v-else class="min-h-screen bg-background text-foreground flex flex-col selection:bg-primary/20">
    <!-- 极简流线型顶栏 (WorkBuddy 标头) -->
    <header class="sticky top-0 z-40 w-full border-b border-border/40 bg-background/80 backdrop-blur-md">
      <div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <!-- Brand Logo & Title -->
        <div class="flex items-center gap-2.5">
          <div class="flex size-7.5 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
            <Cloud class="size-4" />
          </div>
          <span class="text-sm font-semibold tracking-tight text-foreground">CTYUN-PRO</span>
          <Badge variant="outline" class="font-mono text-[10px] px-1.5 py-0 h-4.5 rounded-full border-border/60 text-muted-foreground">
            {{ appVersion }}
          </Badge>
        </div>

        <!-- 顶部右侧系统状态与 GitHub 链接 -->
        <div class="flex items-center gap-3">
          <a
            href="https://github.com/Lei-rr/ctyun-pro"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <span>GitHub</span>
            <ExternalLink class="size-3 opacity-70" />
          </a>
        </div>
      </div>
    </header>

    <!-- 主工作区内容 (居中版心 max-w-6xl) -->
    <main class="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <RouterView />
    </main>

    <!-- WorkBuddy 标志性底部悬浮胶囊 Dock (Floating Dock) -->
    <FloatingDock
      :theme="theme"
      @set-theme="applyTheme"
      @open-system-config="showSystemModal = true"
      @export-profiles="exportProfiles"
      @trigger-import="triggerImport"
    />

    <!-- 全局弹窗组件 -->
    <AddAccountDialog
      v-model:open="store.showAddModal"
      :initial-user="store.addModalUser"
      :initial-name="store.addModalName"
    />

    <PolicyConfigDialog
      v-model:open="store.showPolicyModal"
      :account-name="store.selectedAccount?.name || store.selectedAccount?.user || ''"
      :initial-policy="store.selectedAccount?.policy || 'daily'"
      :initial-hang-config="store.selectedAccount?.hangConfig"
      :initial-task-config="store.selectedAccount?.taskConfig"
      :initial-redeem-config="store.selectedAccount?.redeemConfig"
    />

    <SystemConfigDialog
      v-model:open="showSystemModal"
    />
  </div>
</template>
