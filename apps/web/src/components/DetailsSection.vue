<script setup lang="ts">
import { useStorage } from '@vueuse/core';
import { computed } from 'vue';

/**
 * A category of the Details panel, collapsible like UE's (remembered in
 * this browser). `actions` sit right of the title, e.g. "+ Input".
 */
const props = defineProps<{
  id: string;
  title: string;
  /** Closed until opened once, like UE's "Advanced" parts. */
  defaultCollapsed?: boolean;
}>();

const collapsed = useStorage<Record<string, boolean>>(
  'vizscript:details-collapsed',
  {}
);
const isCollapsed = computed(
  () => collapsed.value[props.id] ?? props.defaultCollapsed ?? false
);

function toggle(): void {
  collapsed.value = { ...collapsed.value, [props.id]: !isCollapsed.value };
}
</script>

<template>
  <section
    :data-ui="`details-${id}`"
    class="border-b border-zinc-800/80 py-2"
    :aria-label="title"
  >
    <div class="flex items-center pr-2">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1 px-2 pb-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
        :aria-expanded="!isCollapsed"
        @click="toggle"
      >
        <span
          class="shrink-0"
          :class="isCollapsed ? 'i-mdi-chevron-right' : 'i-mdi-chevron-down'"
        />
        <span class="truncate">{{ title }}</span>
      </button>
      <slot v-if="!isCollapsed" name="actions" />
    </div>
    <slot v-if="!isCollapsed" />
  </section>
</template>
