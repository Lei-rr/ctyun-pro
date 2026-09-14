<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { AppDialog } from '@/shared/ui/dialog';
import { toast } from 'vue-sonner';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void;
}>();

const store = useAppStore();
const sysKeepAlive = ref(60);
const sysAdminPassword = ref('');
const sysWebhookUrl = ref('');
const sysLoading = ref(false);
const testWebhookLoading = ref(false);

watch(
  () => props.open,
  (val) => {
    if (val) {
      sysKeepAlive.value = store.keepAliveSeconds || 60;
      sysAdminPassword.value = '';
      sysWebhookUrl.value = store.webhookUrl || '';
    }
  },
);

async function handleTestWebhook() {
  const url = sysWebhookUrl.value.trim();
  if (!url) {
    toast.error('请先在输入框中填入 Webhook 地址');
    return;
  }
  testWebhookLoading.value = true;
  try {
    const res = await fetch('/api/config/webhook/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(store.adminToken ? { 'x-admin-token': store.adminToken } : {}),
      },
      body: JSON.stringify({ webhookUrl: url }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.msg || '测试推送失败');
    toast.success(json.msg || '测试消息已成功送达！');
  } catch (e: any) {
    toast.error(e.message || '测试推送失败');
  } finally {
    testWebhookLoading.value = false;
  }
}

async function saveSystemConfig() {
  sysLoading.value = true;
  try {
    const payload: any = {
      keepAliveSeconds: Number(sysKeepAlive.value),
      webhookUrl: sysWebhookUrl.value.trim(),
    };
    if (sysAdminPassword.value.trim()) {
      payload.adminPassword = sysAdminPassword.value.trim();
    }
    const res = await fetch('/api/config/system', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(store.adminToken ? { 'x-admin-token': store.adminToken } : {}),
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.msg || '保存失败');
    emit('update:open', false);
    await store.fetchStatus();
    toast.success('系统配置已持久化保存至 data/config.json');
  } catch (e: any) {
    toast.error(e.message || '保存配置失败');
  } finally {
    sysLoading.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    @update:open="emit('update:open', $event)"
    title="系统设置"
    description="配置项将自动持久化至 data/config.json"
    content-class="sm:max-w-md"
  >
    <form @submit.prevent="saveSystemConfig" class="space-y-4">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-foreground">修改管理员口令 (留空则不修改)</label>
        <Input
          type="password"
          v-model="sysAdminPassword"
          placeholder="设置新密码"
          class="h-9"
        />
      </div>

      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <label class="text-xs font-medium text-foreground">Webhook 推送地址</label>
          <span class="text-[11px] text-muted-foreground">精简告警 + 09:00 早报</span>
        </div>
        <div class="flex gap-2">
          <Input
            type="text"
            v-model="sysWebhookUrl"
            placeholder="支持 Server酱 / Bark / PushPlus / 企微 / 飞书 / 钉钉"
            class="h-9 flex-1 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            :disabled="testWebhookLoading"
            @click="handleTestWebhook"
            class="h-9 px-3 shrink-0 cursor-pointer text-xs"
          >
            {{ testWebhookLoading ? '测试中...' : '测试' }}
          </Button>
        </div>
        <p class="text-[11px] text-muted-foreground/80">仅在凭证失效、兑换成功、重试熔断及每日早报时推送，杜绝刷屏。</p>
      </div>

      <div class="pt-2 flex gap-2.5">
        <Button
          type="button"
          variant="outline"
          @click="emit('update:open', false)"
          class="flex-1 cursor-pointer"
        >
          取消
        </Button>
        <Button
          type="submit"
          :disabled="sysLoading"
          class="flex-1 shadow-xs cursor-pointer"
        >
          {{ sysLoading ? '正在保存...' : '保存配置' }}
        </Button>
      </div>
    </form>
  </AppDialog>
</template>
