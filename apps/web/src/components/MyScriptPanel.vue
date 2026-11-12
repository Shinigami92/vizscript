<script setup lang="ts">
import type { GraphDocument, ScriptSymbol } from '@vizscript/core';
import { pinColor, qualifiedName } from '@vizscript/core';
import { useStorage } from '@vueuse/core';
import { computed, ref } from 'vue';
import { useTheme } from '../composables/use-theme';
import { SYMBOL_ICONS, symbolType, topLevelGraph } from '../graph/symbols';

/**
 * "My Script": what the file declares, like UE's "My Blueprint" panel.
 * Click selects (Details shows it), double-click shows it in the graph.
 */
const props = defineProps<{
  doc: GraphDocument | null;
  text: string;
  selectedSymbol: string | null;
  /** Qualified name of the function the selection is in (its locals show). */
  currentFunction: string | null;
}>();

const emit = defineEmits<{
  selectSymbol: [id: string];
  openSymbol: [id: string];
  selectFunction: [fnId: string];
  select: [ids: string[]];
}>();

const { scheme } = useTheme();
const query = ref('');
const collapsed = useStorage<Record<string, boolean>>(
  'vizscript:my-script-collapsed',
  {}
);

interface Group {
  /** Class (or other owner) the items belong to; `''` for the module. */
  owner: string;
  items: ScriptSymbol[];
}

interface Section {
  id: string;
  title: string;
  groups: Group[];
  empty?: string;
}

function matches(symbol: ScriptSymbol): boolean {
  const q = query.value.trim().toLowerCase();
  return (
    q === '' ||
    symbol.name.toLowerCase().includes(q) ||
    (symbol.type?.text.toLowerCase().includes(q) ?? false)
  );
}

function grouped(items: ReadonlyArray<ScriptSymbol>): Group[] {
  const groups = new Map<string, ScriptSymbol[]>();
  for (const item of items) {
    const list = groups.get(item.scope) ?? [];
    list.push(item);
    groups.set(item.scope, list);
  }

  // Module members first, then one group per class, in code order.
  return [...groups.entries()]
    .map(([owner, list]) => ({ owner, items: list }))
    .toSorted((a, b) => (a.owner === '' ? -1 : b.owner === '' ? 1 : 0));
}

const symbols = computed(() => (props.doc?.symbols ?? []).filter(matches));
const functionScopes = computed(
  () =>
    new Set(
      (props.doc?.symbols ?? [])
        .filter((s) => s.kind === 'function' || s.kind === 'method')
        .map(qualifiedName)
    )
);

const sections = computed<Section[]>(() => {
  const all = symbols.value;
  const of = (...kinds: string[]): ScriptSymbol[] =>
    all.filter((s) => kinds.includes(s.kind));
  const result: Section[] = [
    {
      id: 'functions',
      title: 'Functions',
      groups: grouped(of('function', 'method')),
      empty: 'No functions',
    },
    {
      id: 'variables',
      title: 'Variables',
      groups: grouped(
        of('variable', 'constant').filter(
          (s) => !functionScopes.value.has(s.scope)
        )
      ),
      empty: 'No variables',
    },
  ];

  if (props.currentFunction) {
    result.push({
      id: 'locals',
      title: `Local Variables (${props.currentFunction})`,
      groups: [
        {
          owner: '',
          items: of('local').filter((s) => s.scope === props.currentFunction),
        },
      ],
      empty: 'No local variables',
    });
  }

  const types = of('class', 'type', 'enum');
  if (types.length > 0) {
    result.push({ id: 'types', title: 'Types', groups: grouped(types) });
  }

  const signals = of('signal');
  if (signals.length > 0) {
    result.push({ id: 'signals', title: 'Signals', groups: grouped(signals) });
  }

  return result;
});

const graph = computed(() => topLevelGraph(props.doc, props.text));

const commentBoxes = computed(() =>
  (props.doc?.functions ?? []).flatMap((fn) =>
    (fn.comments ?? [])
      .filter((box) =>
        box.title.toLowerCase().includes(query.value.trim().toLowerCase())
      )
      .map((box) => ({ box, fn }))
  )
);

function toggle(id: string): void {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] };
}

function typeColor(symbol: ScriptSymbol): string {
  return pinColor(symbol.returnType ?? symbol.dataType, scheme.value);
}

/** Short modifiers shown next to the name. */
function badges(symbol: ScriptSymbol): string {
  return symbol.modifiers
    .filter((m) =>
      /^(?:export|export default|static|async|private|protected|@export.*|@onready|readonly|get|set)$/.test(
        m
      )
    )
    .join(' ');
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-zinc-950 text-sm">
    <div class="shrink-0 border-b border-zinc-800 p-2">
      <input
        v-model="query"
        type="search"
        class="input py-1 text-xs"
        placeholder="Search"
        aria-label="Search the script"
      />
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto pb-2" role="tree">
      <section v-if="graph" aria-label="Graphs">
        <button
          type="button"
          class="section-title"
          :aria-expanded="!collapsed.graphs"
          @click="toggle('graphs')"
        >
          <span
            :class="
              collapsed.graphs ? 'i-mdi-chevron-right' : 'i-mdi-chevron-down'
            "
          />
          Graphs
        </button>
        <button
          v-if="!collapsed.graphs"
          type="button"
          class="row pl-6"
          title="Show this graph"
          @click="emit('selectFunction', graph.id)"
        >
          <span class="i-mdi-graph-outline text-red-400" />
          <span class="truncate">{{ graph.name }}</span>
        </button>
      </section>

      <section
        v-for="section in sections"
        :key="section.id"
        :aria-label="section.title"
      >
        <button
          type="button"
          class="section-title"
          :aria-expanded="!collapsed[section.id]"
          @click="toggle(section.id)"
        >
          <span
            :class="
              collapsed[section.id]
                ? 'i-mdi-chevron-right'
                : 'i-mdi-chevron-down'
            "
          />
          <span class="truncate">{{ section.title }}</span>
        </button>
        <template v-if="!collapsed[section.id]">
          <p
            v-if="section.groups.every((g) => g.items.length === 0)"
            class="px-7 py-0.5 text-xs text-zinc-600"
          >
            {{ query ? 'No matches' : section.empty }}
          </p>
          <template v-for="group in section.groups" :key="group.owner">
            <div
              v-if="group.owner && section.id !== 'locals'"
              class="flex items-center gap-1.5 px-6 pt-1 text-xs text-zinc-500"
            >
              <span class="i-mdi-cube-outline" />
              <span class="truncate">{{ group.owner }}</span>
            </div>
            <button
              v-for="symbol in group.items"
              :key="symbol.id"
              type="button"
              role="treeitem"
              class="row"
              :class="[
                group.owner && section.id !== 'locals' ? 'pl-9' : 'pl-6',
                symbol.id === selectedSymbol
                  ? 'bg-amber-500/15 text-zinc-50'
                  : '',
              ]"
              :aria-selected="symbol.id === selectedSymbol"
              :title="`${symbol.name} — double-click to show it in the graph`"
              @click="emit('selectSymbol', symbol.id)"
              @dblclick="emit('openSymbol', symbol.id)"
            >
              <span class="shrink-0" :class="SYMBOL_ICONS[symbol.kind]" />
              <span class="min-w-0 truncate">{{ symbol.name }}</span>
              <span
                v-if="badges(symbol)"
                class="shrink-0 truncate text-[10px] text-zinc-500"
                >{{ badges(symbol) }}</span
              >
              <span
                v-if="symbolType(symbol).text"
                class="ml-auto flex min-w-0 shrink items-center gap-1 pl-2 font-mono text-[11px]"
                :class="
                  symbolType(symbol).inferred
                    ? 'text-zinc-500 italic'
                    : 'text-zinc-400'
                "
                :title="
                  symbolType(symbol).inferred
                    ? `Inferred: ${symbolType(symbol).text}`
                    : symbolType(symbol).text
                "
              >
                <span
                  class="size-2 shrink-0 rounded-full"
                  :style="{ background: typeColor(symbol) }"
                />
                <span class="truncate">{{ symbolType(symbol).text }}</span>
              </span>
            </button>
          </template>
        </template>
      </section>

      <section v-if="commentBoxes.length > 0" aria-label="Comment boxes">
        <button
          type="button"
          class="section-title"
          :aria-expanded="!collapsed.comments"
          @click="toggle('comments')"
        >
          <span
            :class="
              collapsed.comments ? 'i-mdi-chevron-right' : 'i-mdi-chevron-down'
            "
          />
          Comment boxes
        </button>
        <template v-if="!collapsed.comments">
          <button
            v-for="{ box, fn } in commentBoxes"
            :key="box.id"
            type="button"
            class="row pl-6"
            :title="`Select the ${box.nodes.length} nodes of this comment box`"
            @click="emit('select', [...box.nodes])"
          >
            <span class="i-mdi-comment-multiple-outline text-zinc-400" />
            <span class="truncate">{{ box.title || 'Comment' }}</span>
            <span class="ml-auto truncate pl-2 text-xs text-zinc-500">{{
              fn.name
            }}</span>
          </button>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.section-title {
  @apply flex w-full items-center gap-1 px-2 pt-2.5 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-300;
}

.row {
  @apply flex w-full items-center gap-2 py-1 pr-3 text-left text-zinc-300 hover:bg-zinc-800/70 focus-visible:bg-zinc-800/70 focus-visible:outline-none;
}
</style>
