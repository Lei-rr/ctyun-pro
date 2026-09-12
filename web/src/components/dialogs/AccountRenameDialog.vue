<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { AppDialog } from '@/shared/ui/dialog';

const props = defineProps<{
  open: boolean;
  accountName: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void;
}>();

const store = useAppStore();
const inputVal = ref('');
const loading = ref(false);

watch(
  () => props.open,
  (val) => {
    if (val) {
      inputVal.value = props.accountName;
    }
  },
);

async function submitRename() {
  if (!inputVal.value.trim() || !props.accountName) return;
  loading.value = true;
  try {
    await store.renameAccount(props.accountName, inputVal.value.trim());
    emit('update:open', false);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="open"
    @update:open="emit('update:open', $event)"
    title="修改账号备注"
    description="给天翼云账号设置一个更易辨识的备注名称"
    content-class="sm:max-w-sm"
  >
    <form @submit.prevent="submitRename" class="space-y-3.5">
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-foreground">账号新备注</label>
        <Input
          type="text"
          v-model="inputVal"
          placeholder="例如：主账号 / 二号机"
          required
          autofocus
          class="h-9"
        />
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
