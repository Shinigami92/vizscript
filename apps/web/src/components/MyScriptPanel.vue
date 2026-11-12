<script setup lang="ts">
import type { GraphDocument, GraphOp, ScriptSymbol } from '@vizscript/core';
import { pinColor, qualifiedName, uniqueName } from '@vizscript/core';
import { useStorage } from '@vueuse/core';
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { useTheme } from '../composables/use-theme';
import {
  SYMBOL_ICONS,
  SYMBOL_LABELS,
  symbolNodes,
  symbolType,
  topLevelGraph,
} from '../graph/symbols';
import type { MenuEntry } from './ContextMenu.vue';
import ContextMenu from './ContextMenu.vue';

/**
 * "My Script": what the file declares, like UE's "My Blueprint" panel.
 * Click selects (Details shows it), double-click shows it in the graph,
 * `+` adds, F2 renames, Delete removes.
 */
const props = defineProps<{
  doc: GraphDocument | null;
  text: string;
  selectedSymbol: string | null;
  /** Qualified name of the function the selection is in (its locals show). */
  currentFunction: string | null;
  editable: boolean;
}>();

const emit = defineEmits<{
  selectSymbol: [id: string];
  openSymbol: [id: string];
  selectFunction: [fnId: string];
  select: [ids: string[]];
  reveal: [id: string];
  op: [op: GraphOp];
}>();

const { scheme } = useTheme();
const query = ref('');
const collapsed = useStorage<Record<string, boolean>>(
  'vizscript:my-script-collapsed',
  {}
);

type AddKind = 'function' | 'variable' | 'local' | 'signal';

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
  /** What the section's `+` adds. */
  add?: AddKind;
}

/** snake_case for Python and GDScript, camelCase otherwise. */
const snake = computed(
  () => props.doc?.language === 'python' || props.doc?.language === 'gdscript'
);

const BASE_NAMES: Record<AddKind, [string, string]> = {
  function: ['newFunction', 'new_function'],
  variable: ['newVar', 'new_var'],
  local: ['newLocal', 'new_local'],
  signal: ['newSignal', 'new_signal'],
};

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
const classes = computed(() =>
  (props.doc?.symbols ?? []).filter((s) => s.kind === 'class')
);

/** Groups for every class, so `+` can add the first member. */
function withClasses(groups: Group[]): Group[] {
  const owners = new Set(groups.map((g) => g.owner));
  const extra = classes.value
    .map(qualifiedName)
    .filter((owner) => !owners.has(owner) && query.value.trim() === '')
    .map((owner) => ({ owner, items: [] }));
  return [...groups, ...extra];
}

const sections = computed<Section[]>(() => {
  const all = symbols.value;
  const of = (...kinds: string[]): ScriptSymbol[] =>
    all.filter((s) => kinds.includes(s.kind));
  // A GDScript file is a class: its members need no class group.
  const memberGroups = (groups: Group[]): Group[] =>
    props.doc?.language === 'gdscript' ? groups : withClasses(groups);
  const result: Section[] = [
    {
      id: 'functions',
      title: 'Functions',
      groups: memberGroups(grouped(of('function', 'method'))),
      empty: 'No functions',
      add: 'function',
    },
    {
      id: 'variables',
      title: 'Variables',
      groups: memberGroups(
        grouped(
          of('variable', 'constant').filter(
            (s) => !functionScopes.value.has(s.scope)
          )
        )
      ),
      empty: 'No variables',
      add: 'variable',
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
      add: 'local',
    });
  }

  const types = of('class', 'type', 'enum');
  if (types.length > 0) {
    result.push({ id: 'types', title: 'Types', groups: grouped(types) });
  }

  const signals = of('signal');
  if (signals.length > 0 || props.doc?.language === 'gdscript') {
    result.push({
      id: 'signals',
      title: 'Signals',
      groups: [{ owner: '', items: signals }],
      empty: 'No signals',
      add: 'signal',
    });
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

// ---------------------------------------------------------------- editing

/** Symbol whose name is being edited, and the text of the field. */
const editing = ref<string | null>(null);
const draft = ref('');
const field = useTemplateRef<HTMLInputElement[]>('field');
/** A symbol just added: its name is edited as soon as it exists. */
let pending: { scope: string; name: string } | null = null;

async function startRename(symbol: ScriptSymbol): Promise<void> {
  if (!props.editable) {
    return;
  }

  editing.value = symbol.id;
  draft.value = symbol.name;
  await nextTick();
  const input = field.value?.[0];
  input?.focus();
  input?.select();
}

function commitRename(symbol: ScriptSymbol): void {
  if (editing.value !== symbol.id) {
    return;
  }

  editing.value = null;
  const name = draft.value.trim();
  if (name && name !== symbol.name) {
    emit('op', { type: 'renameSymbol', symbol: symbol.id, name });
  }
}

function cancelRename(): void {
  editing.value = null;
}

watch(
  () => props.doc?.symbols,
  (list) => {
    if (!pending) {
      return;
    }

    const { scope, name } = pending;
    const added = list?.find((s) => s.scope === scope && s.name === name);
    if (added) {
      pending = null;
      emit('selectSymbol', added.id);
      void startRename(added);
    }
  }
);

function add(kind: AddKind, owner: string): void {
  const doc = props.doc;
  if (!doc || !props.editable) {
    return;
  }

  const scope = kind === 'local' ? (props.currentFunction ?? '') : owner;
  const [camel, snakeCase] = BASE_NAMES[kind];
  const name = uniqueName(doc, scope, snake.value ? snakeCase : camel);
  pending = { scope, name };
  switch (kind) {
    case 'function': {
      emit('op', { type: 'addFunction', scope, name });
      break;
    }

    case 'variable': {
      emit('op', { type: 'addVariable', scope, name });
      break;
    }

    case 'local': {
      emit('op', { type: 'addVariable', scope, name, local: true });
      break;
    }

    case 'signal': {
      emit('op', { type: 'addSignal', name });
      break;
    }
  }

  // Open the section that shows the new symbol.
  const section = kind === 'local' ? 'locals' : `${kind}s`;
  if (collapsed.value[section]) {
    toggle(section);
  }
}

function remove(symbol: ScriptSymbol): void {
  if (!props.editable) {
    return;
  }

  const uses = symbolNodes(props.doc, symbol).filter(
    (id) =>
      !props.doc?.functions.some(
        (f) =>
          f.id === symbol.fnId &&
          f.nodes.some((n) => n.id === id && n.kind === 'entry')
      )
  ).length;
  const question =
    uses > 0
      ? `${symbol.name} is used by ${uses} node${uses === 1 ? '' : 's'}. Delete it anyway? Its uses stay and will show errors.`
      : undefined;
  // UE asks the same before deleting a variable that is in use.
  if (question && !globalThis.confirm(question)) {
    return;
  }

  emit('op', { type: 'deleteSymbol', symbol: symbol.id });
}

function onRowKeydown(event: KeyboardEvent, symbol: ScriptSymbol): void {
  if (editing.value) {
    return;
  }

  if (event.key === 'F2') {
    event.preventDefault();
    void startRename(symbol);
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    remove(symbol);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    emit('openSymbol', symbol.id);
  }
}

// ------------------------------------------------------------ context menu

const menu = ref<{ x: number; y: number; symbol: ScriptSymbol } | null>(null);

const menuEntries = computed<MenuEntry[]>(() => {
  const symbol = menu.value?.symbol;
  if (!symbol) {
    return [];
  }

  return [
    { type: 'header', label: `${SYMBOL_LABELS[symbol.kind]} ${symbol.name}` },
    {
      label: 'Show in graph',
      icon: 'i-mdi-graph-outline',
      action: () => emit('openSymbol', symbol.id),
    },
    {
      label: 'Jump to code',
      icon: 'i-mdi-code-tags',
      action: () => emit('reveal', symbol.id),
    },
    ...(props.editable
      ? [
          { type: 'separator' } as const,
          {
            label: 'Rename',
            icon: 'i-mdi-rename-outline',
            shortcut: 'F2',
            action: () => void startRename(symbol),
          },
          {
            label: 'Delete',
            icon: 'i-mdi-delete-outline',
            shortcut: 'Del',
            danger: true,
            action: () => remove(symbol),
          },
        ]
      : []),
  ];
});

function openMenu(event: MouseEvent, symbol: ScriptSymbol): void {
  emit('selectSymbol', symbol.id);
  menu.value = { x: event.clientX, y: event.clientY, symbol };
}

function addLabel(kind: AddKind, owner: string): string {
  const what =
    kind === 'local'
      ? 'local variable'
      : owner && kind === 'function'
        ? 'method'
        : kind;
  return owner ? `Add ${what} to ${owner}` : `Add ${what}`;
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
        <div class="group/title flex items-center pr-1">
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
          <button
            v-if="editable && section.add"
            type="button"
            class="add"
            :title="addLabel(section.add, '')"
            :aria-label="addLabel(section.add, '')"
            @click="add(section.add, '')"
          >
            <span class="i-mdi-plus" />
          </button>
        </div>
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
              class="flex items-center gap-1.5 pt-1 pr-1 pl-6 text-xs text-zinc-500"
            >
              <span class="i-mdi-cube-outline" />
              <span class="min-w-0 flex-1 truncate">{{ group.owner }}</span>
              <button
                v-if="editable && section.add"
                type="button"
                class="add"
                :title="addLabel(section.add, group.owner)"
                :aria-label="addLabel(section.add, group.owner)"
                @click="add(section.add, group.owner)"
              >
                <span class="i-mdi-plus" />
              </button>
            </div>
            <template v-for="symbol in group.items" :key="symbol.id">
              <div
                v-if="editing === symbol.id"
                class="flex items-center gap-2 py-0.5 pr-2"
                :class="
                  group.owner && section.id !== 'locals' ? 'pl-9' : 'pl-6'
                "
              >
                <span class="shrink-0" :class="SYMBOL_ICONS[symbol.kind]" />
                <input
                  ref="field"
                  v-model="draft"
                  class="input py-0.5 font-mono text-xs"
                  :aria-label="`New name of ${symbol.name}`"
                  spellcheck="false"
                  @keydown.enter.prevent="commitRename(symbol)"
                  @keydown.esc.prevent="cancelRename"
                  @blur="commitRename(symbol)"
                />
              </div>
              <button
                v-else
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
                :title="`${symbol.name} — double-click to show it in the graph${editable ? ', F2 to rename' : ''}`"
                @click="emit('selectSymbol', symbol.id)"
                @dblclick="emit('openSymbol', symbol.id)"
                @keydown="onRowKeydown($event, symbol)"
                @contextmenu.prevent="openMenu($event, symbol)"
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

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :entries="menuEntries"
      label="Symbol actions"
      @close="menu = null"
    />
  </div>
</template>

<style scoped>
.section-title {
  @apply flex min-w-0 flex-1 items-center gap-1 px-2 pt-2.5 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 hover:text-zinc-300;
}

.row {
  @apply flex w-full items-center gap-2 py-1 pr-3 text-left text-zinc-300 hover:bg-zinc-800/70 focus-visible:bg-zinc-800/70 focus-visible:outline-none;
}

.add {
  @apply mt-1.5 flex size-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:bg-zinc-800 focus-visible:outline-none;
}
</style>
