<script setup lang="ts">
import { ref, watch } from 'vue';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { AppDialog } from '@/shared/ui/dialog';

// 通用重命名弹窗：账号备注与云电脑名称共用，提交逻辑由父组件注入
const props = defineProps<{
  open: boolean;
  title: string;
  description: string;
  label: string;
  placeholder: string;
  initialValue?: string;
  submit: (value: string) => Promise<void>;
}>();

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void;
}>();

const inputVal = ref('');
const loading = ref(false);
const errorMsg = ref('');

watch(
  () => props.open,
  (val) => {
    if (val) {
      inputVal.value = props.initialValue || '';
      errorMsg.value = '';
    }
  },
);

async function handleSubmit() {
  const trimmed = inputVal.value.trim();
  if (!trimmed) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    // props.submit 需可等待，loading 与错误提示依赖其完成时机
    await props.submit(trimmed);
    emit('update:open', false);
  } catch (err: any) {
    errorMsg.value = err?.message || '修改失败，请重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    @update:open="emit('update:open', $event)"
    :title="title"
    :description="description"
    content-class="sm:max-w-sm"
  >
    <form @submit.prevent="handleSubmit" class="space-y-3.5">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-foreground">{{ label }}</label>
        <Input
          type="text"
          v-model="inputVal"
          :placeholder="placeholder"
          required
          autofocus
          class="h-9"
        />
        <p v-if="errorMsg" class="text-xs text-destructive mt-1">{{ errorMsg }}</p>
      </div>

      <div class="pt-2 flex gap-2 w-full">
        <Button
          type="button"
          variant="outline"
          @click="emit('update:open', false)"
          class="flex-1 h-9 cursor-pointer"
        >
          取消
        </Button>
        <Button
          type="submit"
          :disabled="loading || !inputVal.trim()"
          class="flex-1 h-9 shadow-xs cursor-pointer"
        >
          {{ loading ? '正在保存...' : '确认修改' }}
        </Button>
      </div>
    </form>
  </AppDialog>
</template>
