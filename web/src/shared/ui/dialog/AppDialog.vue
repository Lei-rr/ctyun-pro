<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import DialogRoot from './Dialog.vue'
import DialogContent from './DialogContent.vue'
import DialogDescription from './DialogDescription.vue'
import DialogFooter from './DialogFooter.vue'
import DialogHeader from './DialogHeader.vue'
import DialogTitle from './DialogTitle.vue'
import { cn } from '@/shared/lib/utils'

const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    class?: HTMLAttributes['class']
    contentClass?: HTMLAttributes['class']
  }>(),
  {}
)
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogContent
      :class="
        cn(
          'max-h-[92dvh] sm:max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-4 sm:max-w-lg sm:p-6',
          props.contentClass || props.class
        )
      "
    >
      <DialogHeader v-if="title || description || $slots.header" class="min-w-0">
        <slot name="header">
          <DialogTitle v-if="title" class="min-w-0 break-words">{{ title }}</DialogTitle>
          <DialogDescription v-if="description" class="min-w-0 break-words">{{ description }}</DialogDescription>
        </slot>
      </DialogHeader>

      <div class="min-h-0 min-w-0 max-h-[60dvh] sm:max-h-none touch-pan-y overflow-y-auto overflow-x-hidden overscroll-contain px-0.5">
        <div class="grid min-w-0 gap-3 sm:gap-4">
          <slot />
        </div>
      </div>

      <DialogFooter v-if="$slots.footer">
        <slot name="footer" />
      </DialogFooter>
    </DialogContent>
  </DialogRoot>
</template>
