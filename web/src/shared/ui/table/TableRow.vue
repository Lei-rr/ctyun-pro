<script setup lang="ts">
import { cn } from '@/shared/lib/utils'
import type { HTMLAttributes } from 'vue'
const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>
<template>
  <tr
    :class="
      cn(
        'border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted',
        '[&>td:first-child]:transition-[border-radius] [&>td:last-child]:transition-[border-radius]',
        'hover:[&>td:first-child]:rounded-l-lg hover:[&>td:last-child]:rounded-r-lg',
        props.class
      )
    "
  >
    <slot />
  </tr>
</template>
