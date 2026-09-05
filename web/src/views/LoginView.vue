<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { Shield, Lock, ArrowRight } from 'lucide-vue-next';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/shared/ui/card';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';

const router = useRouter();
const store = useAppStore();

const password = ref('');
const loading = ref(false);
const errorMsg = ref('');

async function handleLogin() {
  if (!password.value.trim()) {
    errorMsg.value = '请输入管理员密码';
    return;
  }
  loading.value = true;
  errorMsg.value = '';
  try {
    store.adminPasswordInput = password.value.trim();
    const success = await store.adminLogin();
    if (success) {
      router.replace('/');
    } else {
      errorMsg.value = store.loginError || '登录失败，密码错误';
    }
  } catch (err: any) {
    errorMsg.value = err.message || '登录请求异常';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-svh w-full items-center justify-center p-4 sm:p-6 md:p-10 bg-background text-foreground antialiased selection:bg-muted selection:text-foreground">
    <div class="w-full max-w-sm space-y-4">
      <Card class="border-border/60 shadow-xl rounded-2xl">
        <CardHeader class="space-y-2 text-center pb-4">
          <div class="size-12 mx-auto rounded-2xl bg-muted/60 flex items-center justify-center text-foreground border border-border/40 shadow-xs mb-1">
            <Shield class="size-6 text-primary" />
          </div>
          <CardTitle class="text-xl font-bold tracking-tight">登录 CTYUN-PRO</CardTitle>
          <CardDescription class="text-xs text-muted-foreground">
            请输入天翼云电脑保活管理控制台访问口令
          </CardDescription>
        </CardHeader>

        <CardContent>
          <div v-if="errorMsg" class="mb-4 p-2.5 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs text-center">
            {{ errorMsg }}
          </div>

          <form @submit.prevent="handleLogin" class="space-y-3.5">
            <div class="space-y-1.5">
              <label for="password" class="text-xs font-medium text-foreground">管理口令</label>
              <Input
                id="password"
                v-model="password"
                type="password"
                placeholder="请输入管理员密码"
                autocomplete="current-password"
                required
                autofocus
                class="h-9 rounded-xl"
              />
            </div>

            <Button
              type="submit"
              class="w-full h-9 rounded-xl font-medium shadow-xs cursor-pointer gap-1.5 mt-1"
              :disabled="loading || !password.trim()"
            >
              <span>{{ loading ? '正在验证...' : '进入控制台' }}</span>
              <ArrowRight class="size-3.5" />
            </Button>
          </form>

          <div class="mt-5 text-center pt-2 border-t border-border/40">
            <Button
              variant="ghost"
              size="sm"
              @click="store.toggleTheme()"
              class="text-xs text-muted-foreground hover:text-foreground cursor-pointer h-8 px-2.5"
            >
              切换为{{ store.isDark ? '浅色' : '深色' }}模式
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
