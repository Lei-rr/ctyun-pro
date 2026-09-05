<script setup lang="ts">
import type { SwitchRootEmits, SwitchRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { SwitchRoot, SwitchThumb, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/shared/lib/utils'

interface Props extends /* @vue-ignore */ SwitchRootProps {
  class?: HTMLAttributes['class']
  checked?: boolean
}

export type SwitchEmits = SwitchRootEmits & {
  'update:checked': [payload: boolean]
}

const props = defineProps<Props>()

const emits = defineEmits<SwitchEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'checked')

const internalChecked = computed({
  get() {
    return props.checked !== undefined ? props.checked : (props.modelValue ?? false)
  },
  set(val: boolean) {
    emits('update:modelValue', val)
    emits('update:checked', val)
  }
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <SwitchRoot
    v-slot="slotProps"
    data-slot="switch"
    v-bind="forwarded"
    :model-value="internalChecked"
    @update:model-value="(val: boolean) => internalChecked = val"
    :class="
      cn(
        'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50',
        props.class
      )
    "
  >
    <SwitchThumb
      data-slot="switch-thumb"
      :class="
        cn(
          'bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0'
        )
      "
    >
      <slot name="thumb" v-bind="slotProps" />
    </SwitchThumb>
  </SwitchRoot>
</template>
