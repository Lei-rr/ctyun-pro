<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/shared/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div data-slot="skeleton" :class="cn('bg-muted animate-pulse rounded-md', props.class)" />
</template>
