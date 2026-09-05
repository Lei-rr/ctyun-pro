<script setup lang="ts">
import { computed } from 'vue'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import { Button } from '@/shared/ui/button'
import { confirmState, settleConfirm } from './confirm'

const confirmVariant = computed<'destructive' | 'default'>(() =>
  confirmState.options.value.destructive ? 'destructive' : 'default'
)

function onOpenChange(value: boolean) {
  if (!value) {
    settleConfirm(false)
  }
}

function onConfirm() {
  settleConfirm(true)
}

function onCancel() {
  settleConfirm(false)
}
</script>

<template>
  <AlertDialog :open="confirmState.open.value" @update:open="onOpenChange">
    <AlertDialogContent
      class="max-h-[calc(100svh-1rem)] overflow-y-auto p-4 sm:max-h-[calc(100svh-2rem)] sm:max-w-md sm:p-6"
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{{ confirmState.options.value.title }}</AlertDialogTitle>
        <AlertDialogDescription class="whitespace-pre-wrap">
          {{ confirmState.options.value.description }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter class="flex flex-row items-center justify-end gap-2 [&>*]:w-auto mt-2">
        <Button variant="outline" type="button" @click="onCancel">
          {{ confirmState.options.value.cancelText }}
        </Button>
        <Button :variant="confirmVariant" type="button" @click="onConfirm">
          {{ confirmState.options.value.confirmText }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
