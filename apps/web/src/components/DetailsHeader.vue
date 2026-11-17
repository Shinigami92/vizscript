<script setup lang="ts">
/**
 * The top of the Details panel: what is selected, at a glance. A colored
 * bar and icon, the name, and one line with its exact kind and where it
 * lives. Only shows; names are edited in the sections below.
 */
defineProps<{
  title: string;
  subtitle?: string;
  /** Icon classes, with their color. */
  icon: string;
  /** The bar's color: a background class, or a CSS color. */
  barClass?: string;
  barColor?: string;
}>();
</script>

<template>
  <div
    class="relative border-b border-zinc-800 py-2.5 pl-3.5 pr-3"
    data-ui="details-header"
  >
    <span
      class="absolute inset-y-0 left-0 w-[3px]"
      :class="barClass"
      :style="barColor ? { background: barColor } : undefined"
      aria-hidden="true"
    />
    <div class="flex items-center gap-2">
      <span class="shrink-0" :class="icon" aria-hidden="true" />
      <span class="truncate font-semibold text-zinc-50" :title="title">{{
        title
      }}</span>
    </div>
    <div v-if="subtitle" class="mt-0.5 truncate text-xs text-zinc-400">
      {{ subtitle }}
    </div>
    <slot />
  </div>
</template>
