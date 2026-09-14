<script setup lang="ts">
import { ref } from 'vue';
import { useAppStore } from '@/stores/app';
import { Button } from '@/shared/ui/button';
import { AppDialog } from '@/shared/ui/dialog';

export interface PowerTarget {
  accountName: string;
  desktopCode: string;
  action: 'on' | 'awake' | 'shutdown' | 'reset' | 'force_off' | 'force_reboot';
  desktopName?: string;
}

const props = defineProps<{
  open: boolean;
  target: PowerTarget | null;
}>();

const emit = defineEmits<{
  (e: 'update:open', val: boolean): void;
}>();

const store = useAppStore();
const loading = ref(false);

async function confirmOperate() {
  if (!props.target) return;
  loading.value = true;
  try {
    await store.operateDesktopPower(
      props.target.accountName,
      props.target.desktopCode,
      props.target.action,
    );
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
    :title="
      target?.action === 'on' ? '确认开机' :
      target?.action === 'awake' ? '确认唤醒' :
      target?.action === 'reset' ? '确认重启' :
      target?.action === 'force_reboot' ? '确认强制重启' :
      target?.action === 'force_off' ? '确认强制关机' : '确认关机'
    "
    description="您正在对云电脑进行电源管理操作，请确认："
    content-class="sm:max-w-sm"
  >
    <div v-if="target" class="py-2 space-y-3">
      <div class="p-3 rounded-lg bg-muted/50 border border-border/50 text-xs space-y-1.5">
        <div class="flex justify-between">
          <span class="text-muted-foreground">所属账号:</span>
          <span class="font-medium text-foreground">{{ target.accountName }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">实例标识:</span>
          <span class="font-mono text-foreground">{{ target.desktopName || target.desktopCode }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">执行动作:</span>
          <span
            class="font-semibold"
            :class="{
              'text-emerald-600 dark:text-emerald-400': target.action === 'on' || target.action === 'awake',
              'text-amber-600 dark:text-amber-400': target.action === 'reset' || target.action === 'force_reboot',
              'text-destructive': target.action === 'shutdown' || target.action === 'force_off',
            }"
          >
            {{
              target.action === 'on' ? '开机' :
              target.action === 'awake' ? '休眠唤醒' :
              target.action === 'reset' ? '软重启' :
              target.action === 'force_reboot' ? '强制重启 (硬重置)' :
              target.action === 'force_off' ? '强制断电关机' : '正常关机'
            }}
          </span>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        <template v-if="target.action === 'on' || target.action === 'awake'">
          指令下发后，系统将自动轮询实例状态并在云电脑就绪后自动接入保活。
        </template>
        <template v-else-if="target.action === 'force_off'">
          强制关机将直接切断云电脑电源，相当于拔掉电源线，可能导致未保存的数据丢失。仅建议在系统卡死无响应时使用。
        </template>
        <template v-else-if="target.action === 'force_reboot'">
          强制重启将直接硬件复位虚拟机，可能导致未保存的数据丢失。仅建议在系统卡死无响应时使用。
        </template>
        <template v-else-if="target.action === 'reset'">
          重启可能导致正在运行的保活或任务断开，系统将在重启就绪后自动重新连接。
        </template>
        <template v-else>
          关机后保活通道将自动断开，云电脑将停止产生计费或运行。
        </template>
      </p>
    </div>

    <template #footer>
      <div class="flex gap-2 w-full">
        <Button
          type="button"
          variant="outline"
          @click="emit('update:open', false)"
          class="flex-1 h-9 cursor-pointer"
        >
          取消
        </Button>
        <Button
          type="button"
          :variant="(target?.action === 'shutdown' || target?.action === 'force_off') ? 'destructive' : 'default'"
          :disabled="loading"
          class="flex-1 h-9 shadow-xs cursor-pointer"
          @click="confirmOperate"
        >
          {{ loading ? '正在下发...' : '确认执行' }}
        </Button>
      </div>
    </template>
  </AppDialog>
</template>
