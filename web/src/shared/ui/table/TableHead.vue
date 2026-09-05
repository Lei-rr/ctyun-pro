<script setup lang="ts">
import { cn } from '@/shared/lib/utils'
import type { HTMLAttributes } from 'vue'
const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>
<template>
  <th
    data-slot="table-head"
    :class="
      cn(
        'text-muted-foreground h-10 px-3 text-left align-middle text-xs font-semibold whitespace-nowrap tracking-wider uppercase [&:has([role=checkbox])]:pr-0',
        props.class
      )
    "
  >
    <slot />
  </th>
</template>
