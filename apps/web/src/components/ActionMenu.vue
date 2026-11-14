<script lang="ts">
/** An action of the searchable action menu (like Blueprint's palette). */
export interface ActionEntry {
  label: string;
  /**
   * Group heading, e.g. `Call function` or `Variables`; `''` lists it at
   * the end without a heading, like UE's "Add Comment…".
   */
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
  /** Why the action can't run now; shown dimmed with the reason. */
  disabled?: string;
  /** Without a category: list it first instead of last (UE's "Promote to variable"). */
  first?: boolean;
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
import CollapseTransition from './CollapseTransition.vue';

const props = defineProps<{
  x: number;
  y: number;
  title: string;
  entries: ReadonlyArray<ActionEntry>;
  /** Actions made from the search text (e.g. call a typed name). */
  suggest?: (query: string) => ActionEntry[];
  /** Show the "Context Sensitive" checkbox (hides `fits: false` actions). */
  contextToggle?: boolean;
  /**
   * Categories start folded until opened (UE's right-click menu); opened
   * ones are remembered.
   */
  foldByDefault?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const MAX_RESULTS = 200;

const menu = useTemplateRef<HTMLDivElement>('menu');
const input = useTemplateRef<HTMLInputElement>('input');
const list = useTemplateRef<HTMLUListElement>('list');
const { width, height } = useElementBounding(menu);
const viewport = useWindowSize();
const query = ref('');
/** Keyboard row; none while all is folded and nothing is typed. */
const active = ref(props.foldByDefault ? -1 : 0);
const contextSensitive = useStorage('vizscript:context-sensitive', true);
/** UE's favorites (★): pinned at the top, per browser. */
const favorites = useStorage<string[]>('vizscript:action-favorites', []);
/** Categories folded away (open again while searching). */
const collapsed = useStorage<string[]>('vizscript:action-collapsed', []);
/** Categories opened in menus that fold by default. */
const expanded = useStorage<string[]>('vizscript:action-expanded', []);

const FAVORITES = 'Favorites';
/** Group of uncategorized actions listed first. */
const FIRST = '\u0000first';

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

function toggle(items: string[], item: string): string[] {
  return items.includes(item)
    ? items.filter((c) => c !== item)
    : [...items, item];
}

/** Favorites stay open unless folded, like in the other menus. */
function foldsByDefault(category: string): boolean {
  return props.foldByDefault === true && category !== FAVORITES;
}

function isFolded(category: string): boolean {
  if (category === '' || category === FIRST) {
    return false;
  }

  return foldsByDefault(category)
    ? !expanded.value.includes(category)
    : collapsed.value.includes(category);
}

function toggleCategory(category: string): void {
  if (foldsByDefault(category)) {
    expanded.value = toggle(expanded.value, category);
  } else {
    collapsed.value = toggle(collapsed.value, category);
  }

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
    const category =
      entry.category === '' && entry.first ? FIRST : entry.category;
    const group = byCategory.get(category) ?? {
      best: s,
      order: byCategory.size,
      items: [],
    };
    group.best = Math.min(group.best, s);
    group.items.push(entry);
    byCategory.set(category, group);
  }

  const starred = new Set(favorites.value);
  const pinned = [...byCategory.values()]
    .flatMap((g) => g.items)
    .filter((entry) => starred.has(keyOf(entry)));
  const sorted = [...byCategory.entries()]
    .map(([category, g]) => ({ category, ...g }))
    .toSorted(
      (a, b) =>
        Number(a.category === '') - Number(b.category === '') ||
        a.best - b.best ||
        a.order - b.order
    );
  const favoriteGroup =
    pinned.length > 0
      ? [{ category: FAVORITES, best: -1, order: -1, items: pinned }]
      : [];
  const all = [
    ...sorted.filter((g) => g.category === FIRST),
    ...favoriteGroup,
    ...sorted.filter((g) => g.category !== FIRST),
  ];

  // Rows get their place in the keyboard order; folded groups have none.
  let index = 0;
  return all.map((group) => {
    const folded = !text && isFolded(group.category);
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
  active.value = props.foldByDefault && !query.value.trim() ? -1 : 0;
});

async function scrollToActive(): Promise<void> {
  await nextTick();
  list.value
    ?.querySelector<HTMLElement>('[data-active="true"]')
    ?.scrollIntoView({ block: 'nearest' });
}

function run(entry: ActionEntry | undefined): void {
  if (!entry || entry.disabled) {
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
        active.value =
          active.value < 0
            ? step > 0
              ? 0
              : total - 1
            : (active.value + step + total) % total;
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
        <li
          v-if="group.category === ''"
          role="presentation"
          class="mx-1.5 mt-1.5 border-t border-zinc-800"
        />
        <li v-else-if="group.category === FIRST" role="presentation" />
        <li v-else role="presentation">
          <button
            type="button"
            tabindex="-1"
            class="flex w-full items-center gap-1 rounded px-1.5 pt-2 pb-0.5 text-left text-[11px] font-semibold tracking-wide text-zinc-500 uppercase hover:text-zinc-300"
            :aria-expanded="!group.folded"
            @click="toggleCategory(group.category)"
          >
            <span
              class="motion-rotate i-mdi-chevron-down shrink-0"
              :class="{ '-rotate-90': group.folded }"
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
        <li role="presentation">
          <CollapseTransition>
            <ul v-if="!group.folded" role="group" :aria-label="group.category">
              <li
                v-for="row in group.rows"
                :id="`action-${row.index}`"
                :key="`${group.category}|${keyOf(row.entry)}`"
                role="option"
                :aria-selected="row.index === active"
                :aria-disabled="row.entry.disabled ? true : undefined"
                :data-active="row.index === active"
                :title="row.entry.disabled"
                class="group flex items-center gap-2 rounded px-2.5 py-1 text-zinc-200"
                :class="[
                  row.index === active
                    ? 'bg-amber-500/20'
                    : 'hover:bg-zinc-800',
                  row.entry.disabled ? 'cursor-default' : 'cursor-pointer',
                ]"
                @mousemove="active = row.index"
                @click="run(row.entry)"
              >
                <span
                  class="shrink-0"
                  :class="[
                    row.entry.icon ?? 'i-mdi-circle-small text-zinc-500',
                    { 'opacity-40': row.entry.disabled },
                  ]"
                />
                <span
                  class="min-w-0 flex-1 truncate"
                  :class="{ 'text-zinc-500': row.entry.disabled }"
                  >{{ row.entry.label }}</span
                >
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
            </ul>
          </CollapseTransition>
        </li>
      </template>
    </ul>
    <!-- UE's action tooltip: signature and description of the active one. -->
    <div
      v-if="activeEntry?.disabled"
      data-ui="action-detail"
      class="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-400"
    >
      {{ activeEntry.disabled }}
    </div>
    <div
      v-else-if="activeEntry?.detail"
      data-ui="action-detail"
      class="border-t border-zinc-800 px-3 py-2 text-xs whitespace-pre-wrap text-zinc-400"
    >
      {{ activeEntry.detail }}
    </div>
  </div>
</template>
