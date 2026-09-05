<script setup lang="ts">
import Tooltip from './Tooltip.vue'
import TooltipContent from './TooltipContent.vue'
import TooltipTrigger from './TooltipTrigger.vue'

defineProps<{
  content?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  disabled?: boolean
}>()
</script>

<template>
  <Tooltip v-if="content && !disabled">
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipContent :side="side" :align="align">
      {{ content }}
    </TooltipContent>
  </Tooltip>
  <slot v-else />
</template>
