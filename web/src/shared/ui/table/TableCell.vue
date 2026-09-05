<script setup lang="ts">
import { cn } from '@/shared/lib/utils'
import type { HTMLAttributes } from 'vue'
const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>
<template>
  <td :class="cn('p-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0', props.class)"><slot /></td>
</template>
