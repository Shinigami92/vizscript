<script lang="ts">
/** An action of the searchable action menu (like Blueprint's palette). */
export interface ActionEntry {
  label: string;
  /** Group heading, e.g. `Call function` or `Variables`. */
  category: string;
  icon?: string;
  /** Extra words that find the action. */
  keywords?: string;
  /** Hint on the right, e.g. a type. */
  hint?: string;
  /** Shown below the list while active, e.g. a signature and its doc. */
  detail?: string;
  /**
   * Whether the action fits the pin the wire came from (types match).
   * Hidden while "Context Sensitive" is on; default `true`.
   */
  fits?: boolean;
  /** Runs the action; `query` is the search text (e.g. a name to use). */
  action: (query: string) => void;
}
</script>

<script setup lang="ts">
import {
  onClickOutside,
  useElementBounding,
  useStorage,
  useWindowSize,
} from '@vueuse/core';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue';

const props = defineProps<{
  x: number;
  y: number;
  title: string;
  entries: ReadonlyArray<ActionEntry>;
  /** Actions made from the search text (e.g. call a typed name). */
  suggest?: (query: string) => ActionEntry[];
  /** Show the "Context Sensitive" checkbox (when a wire was dragged). */
  contextToggle?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const MAX_RESULTS = 200;

const menu = useTemplateRef<HTMLDivElement>('menu');
const input = useTemplateRef<HTMLInputElement>('input');
const list = useTemplateRef<HTMLUListElement>('list');
const { width, height } = useElementBounding(menu);
const viewport = useWindowSize();
const query = ref('');
const active = ref(0);
const contextSensitive = useStorage('vizscript:context-sensitive', true);
/** UE's favorites (★): pinned at the top, per browser. */
const favorites = useStorage<string[]>('vizscript:action-favorites', []);
/** Categories folded away (open again while searching). */
const collapsed = useStorage<string[]>('vizscript:action-collapsed', []);

const FAVORITES = 'Favorites';

function keyOf(entry: ActionEntry): string {
  return `${entry.category}:${entry.label}`;
}

function toggleFavorite(entry: ActionEntry): void {
  const key = keyOf(entry);
  favorites.value = favorites.value.includes(key)
    ? favorites.value.filter((k) => k !== key)
    : [...favorites.value, key];
  input.value?.focus({ preventScroll: true });
}

function toggleCategory(category: string): void {
  collapsed.value = collapsed.value.includes(category)
    ? collapsed.value.filter((c) => c !== category)
    : [...collapsed.value, category];
  input.value?.focus({ preventScroll: true });
}

const position = computed(() => ({
  left: `${Math.max(4, Math.min(props.x, viewport.width.value - width.value - 4))}px`,
  top: `${Math.max(4, Math.min(props.y, viewport.height.value - height.value - 4))}px`,
}));

function score(entry: ActionEntry, tokens: string[]): number | undefined {
  const label = entry.label.toLowerCase();
  const haystack =
    `${label} ${entry.category} ${entry.keywords ?? ''}`.toLowerCase();
  if (!tokens.every((t) => haystack.includes(t))) {
    return undefined;
  }

  const first = tokens[0] ?? '';
  return label.startsWith(first) ? 0 : label.includes(first) ? 1 : 2;
}

/** Matching actions, grouped by category, best groups first. */
const groups = computed(() => {
  const text = query.value.trim();
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const typed = text && props.suggest ? props.suggest(text) : [];
  const candidates = [...typed, ...props.entries].filter(
    (e) => !(props.contextToggle && contextSensitive.value && e.fits === false)
  );

  const byCategory = new Map<
    string,
    { best: number; order: number; items: ActionEntry[] }
  >();
  let count = 0;
  for (const entry of candidates) {
    const matched = tokens.length > 0 ? score(entry, tokens) : 2;
    if (matched === undefined || count >= MAX_RESULTS) {
      continue;
    }

    // Made from the search text ("Call loop()"): after real actions that
    // match as well, before ones that match worse.
    const s = typed.includes(entry) ? matched + 1.5 : matched;

    count++;
    const group = byCategory.get(entry.category) ?? {
      best: s,
      order: byCategory.size,
      items: [],
    };
    group.best = Math.min(group.best, s);
    group.items.push(entry);
    byCategory.set(entry.category, group);
  }

  const starred = new Set(favorites.value);
  const pinned = [...byCategory.values()]
    .flatMap((g) => g.items)
    .filter((entry) => starred.has(keyOf(entry)));
  const sorted = [...byCategory.entries()]
    .map(([category, g]) => ({ category, ...g }))
    .toSorted((a, b) => a.best - b.best || a.order - b.order);
  const all =
    pinned.length > 0
      ? [{ category: FAVORITES, best: -1, order: -1, items: pinned }, ...sorted]
      : sorted;

  // Rows get their place in the keyboard order; folded groups have none.
  let index = 0;
  return all.map((group) => {
    const folded = !text && collapsed.value.includes(group.category);
    return {
      category: group.category,
      count: group.items.length,
      folded,
      rows: folded
        ? []
        : group.items.map((entry) => ({ entry, index: index++ })),
    };
  });
});

const flat = computed(() =>
  groups.value.flatMap((g) => g.rows.map((r) => r.entry))
);

const activeEntry = computed(() => flat.value[active.value]);

watch([query, contextSensitive], () => {
  active.value = 0;
});

async function scrollToActive(): Promise<void> {
  await nextTick();
  list.value
    ?.querySelector<HTMLElement>('[data-active="true"]')
    ?.scrollIntoView({ block: 'nearest' });
}

function run(entry: ActionEntry | undefined): void {
  if (!entry) {
    return;
  }

  entry.action(query.value.trim());
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  const total = flat.value.length;
  switch (event.key) {
    case 'Escape': {
      event.preventDefault();
      emit('close');
      break;
    }

    case 'ArrowDown':
    case 'ArrowUp': {
      event.preventDefault();
      if (total > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        active.value = (active.value + step + total) % total;
        void scrollToActive();
      }

      break;
    }

    case 'Enter': {
      event.preventDefault();
      run(flat.value[active.value]);
      break;
    }

    default: {
      break;
    }
  }
}

// A menu opened on pointer release (a dropped wire) would see that same
// release as an outside click: arm after it.
let armed = false;
const arm = setTimeout(() => {
  armed = true;
}, 0);
onBeforeUnmount(() => clearTimeout(arm));
onClickOutside(menu, () => {
  if (armed) {
    emit('close');
  }
});

onMounted(async () => {
  await nextTick();
  input.value?.focus({ preventScroll: true });
});
</script>

<template>
  <div
    ref="menu"
    data-ui="action-menu"
    role="dialog"
    :aria-label="title"
    class="motion-pop fixed z-40 flex max-h-[min(480px,80vh)] w-80 flex-col rounded-lg border border-zinc-700 bg-zinc-900/98 text-sm shadow-2xl backdrop-blur"
    :style="position"
    @keydown="onKeydown"
  >
    <div
      class="flex items-center gap-2 border-b border-zinc-800 px-2.5 pt-2 pb-1.5"
    >
      <span class="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-300">
        {{ title }}
      </span>
      <label
        v-if="contextToggle"
        class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-zinc-400"
      >
        <input
          v-model="contextSensitive"
          type="checkbox"
          class="accent-amber-500"
        />
        Context Sensitive
      </label>
    </div>
    <div class="px-2 py-1.5">
      <input
        ref="input"
        v-model="query"
        type="search"
        class="input"
        placeholder="Search"
        aria-label="Search actions"
        role="combobox"
        aria-autocomplete="list"
        :aria-activedescendant="
          flat.length > 0 ? `action-${active}` : undefined
        "
        aria-controls="action-list"
        aria-expanded="true"
      />
    </div>
    <ul
      id="action-list"
      ref="list"
      role="listbox"
      class="min-h-0 flex-1 overflow-y-auto px-1 pb-1"
    >
      <li
        v-if="groups.length === 0"
        class="px-3 py-2 text-xs text-zinc-500"
        role="presentation"
      >
        No matching actions.
      </li>
      <template v-for="group in groups" :key="group.category">
        <li role="presentation">
          <button
            type="button"
            tabindex="-1"
            class="flex w-full items-center gap-1 rounded px-1.5 pt-2 pb-0.5 text-left text-[11px] font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-300"
            :aria-expanded="!group.folded"
            @click="toggleCategory(group.category)"
          >
            <span
              class="shrink-0"
              :class="
                group.folded ? 'i-mdi-chevron-right' : 'i-mdi-chevron-down'
              "
            />
            <span
              v-if="group.category === FAVORITES"
              class="i-mdi-star shrink-0 text-amber-400"
            />
            <span class="min-w-0 flex-1 truncate">{{ group.category }}</span>
            <span
              v-if="group.folded"
              class="font-normal tracking-normal normal-case"
              >{{ group.count }}</span
            >
          </button>
        </li>
        <li
          v-for="row in group.rows"
          :id="`action-${row.index}`"
          :key="`${group.category}|${keyOf(row.entry)}`"
          role="option"
          :aria-selected="row.index === active"
          :data-active="row.index === active"
          class="group flex cursor-pointer items-center gap-2 rounded px-2.5 py-1 text-zinc-200"
          :class="
            row.index === active ? 'bg-amber-500/20' : 'hover:bg-zinc-800'
          "
          @mousemove="active = row.index"
          @click="run(row.entry)"
        >
          <span
            class="shrink-0"
            :class="row.entry.icon ?? 'i-mdi-circle-small text-zinc-500'"
          />
          <span class="min-w-0 flex-1 truncate">{{ row.entry.label }}</span>
          <span
            v-if="row.entry.hint"
            class="shrink-0 font-mono text-[11px] text-zinc-500"
            >{{ row.entry.hint }}</span
          >
          <button
            type="button"
            tabindex="-1"
            class="shrink-0"
            :class="
              favorites.includes(keyOf(row.entry))
                ? 'i-mdi-star text-amber-400'
                : 'i-mdi-star-outline text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-amber-400'
            "
            :aria-label="
              favorites.includes(keyOf(row.entry))
                ? 'Remove from favorites'
                : 'Add to favorites'
            "
            :title="
              favorites.includes(keyOf(row.entry))
                ? 'Remove from favorites'
                : 'Add to favorites'
            "
            @click.stop="toggleFavorite(row.entry)"
          />
        </li>
      </template>
    </ul>
    <!-- UE's action tooltip: signature and description of the active one. -->
    <div
      v-if="activeEntry?.detail"
      data-ui="action-detail"
      class="border-t border-zinc-800 px-3 py-2 text-xs whitespace-pre-wrap text-zinc-400"
    >
      {{ activeEntry.detail }}
    </div>
  </div>
</template>
