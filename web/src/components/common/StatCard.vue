<script setup lang="ts">
import type { Component } from 'vue';
import { cn } from '@/shared/lib/utils';

export type StatTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const TONE_VALUE: Record<StatTone, string> = {
  neutral: 'text-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  info: 'text-blue-600 dark:text-blue-400',
  accent: 'text-violet-600 dark:text-violet-400',
};

const TONE_ICON: Record<StatTone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  info: 'text-blue-600 dark:text-blue-400',
  accent: 'text-violet-600 dark:text-violet-400',
};

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    icon?: Component;
    tone?: StatTone;
    hintTone?: StatTone;
  }>(),
  {
    tone: 'neutral',
  }
);
</script>

<template>
  <div
    class="min-h-[88px] sm:min-h-[96px] rounded-[20px] bg-muted/60 dark:bg-muted/40 backdrop-blur-sm border border-border/40 px-4 py-3 sm:px-4.5 flex flex-col justify-between transition-all hover:bg-muted/80"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="text-[11px] font-medium text-muted-foreground truncate">
        {{ label }}
      </div>
      <div
        v-if="icon"
        :class="cn(
          'h-6 w-6 shrink-0 rounded-full bg-background/80 dark:bg-white/[0.06] grid place-items-center shadow-xs',
          TONE_ICON[tone]
        )"
      >
        <component :is="icon" class="h-3.5 w-3.5" />
      </div>
    </div>
    
    <div
      :class="cn(
        'mt-2 text-xl sm:text-2xl font-semibold tracking-[-0.03em] tabular-nums',
        TONE_VALUE[tone]
      )"
    >
      {{ value }}
    </div>

    <div
      v-if="hint"
      :class="cn(
        'mt-1 text-[11px] truncate',
        hintTone ? TONE_VALUE[hintTone] : 'text-muted-foreground'
      )"
    >
      {{ hint }}
    </div>
  </div>
</template>
