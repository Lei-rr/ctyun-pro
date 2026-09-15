<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
  title: string;
  description?: string;
}>();
</script>

<template>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6">
    <div class="space-y-1">
      <h1 class="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">{{ title }}</h1>
      <p v-if="description" class="text-xs sm:text-sm text-muted-foreground">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
