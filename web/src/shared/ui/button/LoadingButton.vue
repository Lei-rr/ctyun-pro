<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import type { ButtonVariants } from './variants'
import { LoaderCircle } from '@lucide/vue'
import Button from './Button.vue'

interface Props extends PrimitiveProps {
  variant?: ButtonVariants['variant']
  size?: ButtonVariants['size']
  class?: HTMLAttributes['class']
  loading?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}

withDefaults(defineProps<Props>(), {
  as: 'button',
  loading: false,
  disabled: false,
  type: 'button',
})
</script>

<template>
  <Button
    :as="as"
    :as-child="asChild"
    :variant="variant"
    :size="size"
    :class="['relative', $props.class]"
    :type="asChild ? undefined : type"
    :disabled="asChild ? undefined : disabled || loading"
    :aria-busy="loading || undefined"
    :data-loading="loading ? 'true' : undefined"
  >
    <slot v-if="asChild || !loading" />
    <template v-else>
      <LoaderCircle class="absolute size-4 animate-spin" aria-hidden="true" />
      <span class="flex items-center gap-[inherit] opacity-0"><slot /></span>
    </template>
  </Button>
</template>
