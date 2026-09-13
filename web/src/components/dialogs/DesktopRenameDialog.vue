<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { AppDialog } from '@/shared/ui/dialog';

const props = defineProps<{
  open: boolean;
  desktopCode: string;
  currentName: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void;
}>();

const store = useAppStore();
const inputVal = ref('');
const loading = ref(false);
const errorMsg = ref('');

watch(
  () => props.open,
  (val) => {
    if (val) {
      inputVal.value = props.currentName || '';
      errorMsg.value = '';
    }
  },
);

async function submitRename() {
  const trimmed = inputVal.value.trim();
  if (!trimmed || !props.desktopCode) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    await store.renameDesktop(props.desktopCode, trimmed);
    emit('update:open', false);
  } catch (err: any) {
    errorMsg.value = err.message || '修改失败，请重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    @update:open="emit('update:open', $event)"
    title="修改云电脑名称"
    description="同步修改天翼云官方控制台显示的云电脑昵称"
    content-class="sm:max-w-sm"
  >
    <form @submit.prevent="submitRename" class="space-y-3.5">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-foreground">云电脑新名称</label>
        <Input
          type="text"
          v-model="inputVal"
          placeholder="例如：挂机专用机 / 开发机"
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
