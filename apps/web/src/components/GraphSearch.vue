<script setup lang="ts">
import type { GraphDocument, SearchMatch } from '@vizscript/core';
import { searchNodes } from '@vizscript/core';
import { refDebounced } from '@vueuse/core';
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import { lineLookup } from '../graph/source';

const props = defineProps<{
  doc: GraphDocument | null;
  text: string;
}>();

const emit = defineEmits<{
  /** Select and focus one result. */
  select: [nodeId: string];
  /** All current matches, for highlighting. */
  matches: [nodeIds: string[]];
  close: [];
}>();

const query = ref('');
const debounced = refDebounced(query, 80);
const active = ref(-1);
const input = useTemplateRef<HTMLInputElement>('input');
const list = useTemplateRef<HTMLUListElement>('list');

const results = computed<SearchMatch[]>(() =>
  props.doc ? searchNodes(props.doc, debounced.value) : []
);

watch(results, (value) => {
  active.value = -1;
  emit(
    'matches',
    value.map((m) => m.node.id)
  );
});

const lineOf = computed(() => lineLookup(props.text));

function line(match: SearchMatch): number {
  return lineOf.value(match.node.range.start);
}

async function go(index: number): Promise<void> {
  const count = results.value.length;
  if (count === 0) {
    return;
  }

  active.value = (index + count) % count;
  const match = results.value[active.value];
  if (match) {
    emit('select', match.node.id);
  }

  await nextTick();
  list.value
    ?.querySelector(`[data-index="${active.value}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  } else if (event.key === 'Enter') {
    event.preventDefault();
    void go(active.value + (event.shiftKey ? -1 : 1));
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    void go(active.value + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    void go(active.value - 1);
  }
}

const FIELD_LABELS: Record<SearchMatch['field'], string> = {
  title: '',
  subtitle: 'subtitle',
  pin: 'pin',
  value: 'value',
  function: 'function',
  comment: 'comment',
};

onMounted(() => {
  input.value?.focus();
});

defineExpose({
  focus: () => {
    input.value?.focus();
    input.value?.select();
  },
});
</script>

<template>
  <div
    class="absolute right-3 top-3 z-20 flex w-[min(24rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900/97 shadow-2xl"
    role="search"
  >
    <div class="flex items-center gap-1.5 px-2 py-1.5">
      <span class="i-mdi-magnify shrink-0 text-zinc-500" />
      <input
        ref="input"
        v-model="query"
        aria-label="Find in graph"
        placeholder="Find nodes, values, pins…"
        class="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
        @keydown="onKeydown"
      />
      <span
        v-if="query"
        class="shrink-0 text-xs tabular-nums text-zinc-500"
        aria-live="polite"
      >
        {{
          results.length === 0
            ? 'No results'
            : `${active >= 0 ? active + 1 : '–'} / ${results.length}`
        }}
      </span>
      <button
        type="button"
        class="btn-ghost px-1"
        title="Previous (Shift+Enter)"
        :disabled="results.length === 0"
        @click="go(active - 1)"
      >
        <span class="i-mdi-chevron-up" />
      </button>
      <button
        type="button"
        class="btn-ghost px-1"
        title="Next (Enter)"
        :disabled="results.length === 0"
        @click="go(active + 1)"
      >
        <span class="i-mdi-chevron-down" />
      </button>
      <button
        type="button"
        class="btn-ghost px-1"
        title="Close (Esc)"
        @click="emit('close')"
      >
        <span class="i-mdi-close" />
      </button>
    </div>
    <ul
      v-if="results.length > 0"
      ref="list"
      class="max-h-72 overflow-y-auto border-t border-zinc-800 py-1"
    >
      <li v-for="(match, i) in results" :key="match.node.id" :data-index="i">
        <button
          type="button"
          class="flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm"
          :class="
            i === active
              ? 'bg-amber-500/15 text-zinc-50'
              : 'text-zinc-300 hover:bg-zinc-800'
          "
          @click="go(i)"
        >
          <span class="truncate">{{ match.node.title }}</span>
          <span
            v-if="match.field !== 'title'"
            class="truncate text-xs text-zinc-500"
          >
            {{ FIELD_LABELS[match.field] }}: {{ match.text }}
          </span>
          <span class="ml-auto shrink-0 text-xs text-zinc-500">
            {{ match.fn.name }} · {{ line(match) }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
