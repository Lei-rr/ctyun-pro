<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
  icon?: Component;
  title: string;
  description?: string;
  className?: string;
}>();
</script>

<template>
  <div :class="className || 'flex flex-col items-center justify-center text-center p-8 h-full'">
    <div v-if="icon" class="mx-auto size-15 bg-muted rounded-full flex items-center justify-center mb-4 shadow-2xs">
      <component :is="icon" class="size-8 text-muted-foreground" />
    </div>
    <div class="mb-2 text-base font-bold tracking-tight text-foreground">
      {{ title }}
    </div>
    <div v-if="description" class="mb-4 text-xs text-muted-foreground max-w-sm">
      {{ description }}
    </div>
    <div v-if="$slots.default">
      <slot />
    </div>
  </div>
</template>
