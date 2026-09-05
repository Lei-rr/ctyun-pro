<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue'
import { cn } from '@/shared/lib/utils'
import { badgeVariants, type BadgeVariants } from './variants'

const props = withDefaults(
  defineProps<{
    class?: HTMLAttributes['class']
    variant?: BadgeVariants['variant']
  }>(),
  { variant: 'default' }
)

const classes = computed(() => cn(badgeVariants({ variant: props.variant }), props.class))
</script>

<template>
  <span data-slot="badge" :class="classes"><slot /></span>
</template>
