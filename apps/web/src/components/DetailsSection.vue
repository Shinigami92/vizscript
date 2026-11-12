<script lang="ts">
import type { InjectionKey, Ref } from 'vue';

/** The search text of the Details panel, provided by `DetailsPanel`. */
export const DETAILS_QUERY: InjectionKey<Ref<string>> = Symbol('details-query');
</script>

<script setup lang="ts">
import { useStorage } from '@vueuse/core';
import {
  computed,
  inject,
  nextTick,
  onMounted,
  onUpdated,
  ref,
  useTemplateRef,
  watch,
} from 'vue';

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

/** Opened by a click (not by showing another selection): animate it. */
const toggled = ref(false);

function toggle(): void {
  toggled.value = true;
  collapsed.value = { ...collapsed.value, [props.id]: !isCollapsed.value };
}

// Search: a section shows when its title or content (also the values of
// its fields) contains the text; matching sections open.
const query = inject(DETAILS_QUERY, ref(''));
const root = useTemplateRef<HTMLElement>('root');
const matches = ref(true);
const searching = computed(() => query.value.trim() !== '');
const open = computed(() => searching.value || !isCollapsed.value);

function check(): void {
  const q = query.value.trim().toLowerCase();
  const el = root.value;
  if (!q || !el) {
    matches.value = true;
    return;
  }

  const values = [
    ...el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea, select'
    ),
  ].map((field) => field.value);
  const text = [props.title, el.textContent ?? '', ...values]
    .join(' ')
    .toLowerCase();
  if (text.includes(q) !== matches.value) {
    matches.value = text.includes(q);
  }
}

watch(query, () => void nextTick(check));
onMounted(check);
onUpdated(check);
</script>

<template>
  <section
    v-show="matches"
    ref="root"
    :data-ui="`details-${id}`"
    class="border-b border-zinc-800/80 py-2"
    :aria-label="title"
  >
    <div class="flex items-center pr-2">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1 px-2 pb-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
        :aria-expanded="open"
        @click="toggle"
      >
        <span
          class="motion-rotate i-mdi-chevron-down shrink-0"
          :class="open ? '' : '-rotate-90'"
        />
        <span class="truncate">{{ title }}</span>
      </button>
      <slot v-if="open" name="actions" />
    </div>
    <div v-if="open" :class="toggled ? 'motion-expand' : ''">
      <slot />
    </div>
  </section>
</template>
