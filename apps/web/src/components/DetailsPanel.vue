<script setup lang="ts">
import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  Pin,
  ScriptSymbol,
  SourceRange,
  TypeSystemInfo,
} from '@vizscript/core';
import type { StatementMeta } from '@vizscript/core';
import {
  ASSIGN_OPERATORS,
  CATEGORY_COLORS,
  COMMENT_BOX_COLORS,
  declaringNode,
  fieldValue,
  getMeta,
  isConstantValue,
} from '@vizscript/core';
import { computed, provide, ref } from 'vue';
import { indexDocument, pinPeers } from '../graph/doc-index';
import { lineColumn, snippet } from '../graph/source';
import DetailsSection, { DETAILS_QUERY } from './DetailsSection.vue';
import PinIcon from './PinIcon.vue';
import SymbolDetails from './SymbolDetails.vue';

const props = defineProps<{
  doc: GraphDocument | null;
  text: string;
  selection: ReadonlyArray<string>;
  editable: boolean;
  /** Show a close button (the workbench tab has one on desktop). */
  closable?: boolean;
  /** Symbol selected in "My Script" (shown instead of nodes). */
  symbol?: ScriptSymbol | null;
  /** Number of nodes using the symbol. */
  symbolUses?: number;
  /** File the selected import resolves to (`null`: none). */
  importPath?: string | null;
  /** Types and modifiers of the file's language. */
  types?: TypeSystemInfo | null;
  /** The text `doc` was parsed from (symbol ranges point into it). */
  docText?: string;
  /** Variable of a selected Get / Set node, shown above the node. */
  nodeSymbol?: ScriptSymbol | null;
  /** Palette index of a comment box's color (0: default). */
  boxColorOf?: (boxId: string) => number;
  /** The saved version of the file and its parse (reset ↶). */
  baseDoc?: GraphDocument | null;
  baseText?: string;
}>();

const emit = defineEmits<{
  select: [ids: string[]];
  selectFunction: [fnId: string];
  activate: [id: string];
  reveal: [range: SourceRange];
  openSymbol: [id: string];
  openImport: [id: string];
  selectSymbol: [id: string];
  /** A comment box gets another color (palette index, 0: default). */
  boxColor: [boxId: string, index: number];
  op: [op: GraphOp];
  close: [];
}>();

// --------------------------------------------------------- search, lock

/** Filters the sections (`DetailsSection` injects it). */
const query = ref('');
provide(DETAILS_QUERY, query);

/** UE's lock: the panel keeps showing what was selected when locked. */
const locked = ref<{
  selection: string[];
  symbolId: string | null;
  nodeSymbolId: string | null;
} | null>(null);

function toggleLock(): void {
  locked.value = locked.value
    ? null
    : {
        selection: [...props.selection],
        symbolId: props.symbol?.id ?? null,
        nodeSymbolId: props.nodeSymbol?.id ?? null,
      };
}

function symbolById(id: string | null): ScriptSymbol | null {
  return id ? (props.doc?.symbols?.find((s) => s.id === id) ?? null) : null;
}

const shownSelection = computed(
  () => locked.value?.selection ?? props.selection
);
const shownSymbol = computed(() =>
  locked.value ? symbolById(locked.value.symbolId) : (props.symbol ?? null)
);
const shownNodeSymbol = computed(() =>
  locked.value
    ? symbolById(locked.value.nodeSymbolId)
    : (props.nodeSymbol ?? null)
);
/** Uses and file of a locked symbol are only known while it's selected. */
const shownUses = computed(() =>
  shownSymbol.value?.id === props.symbol?.id
    ? (props.symbolUses ?? 0)
    : undefined
);
const shownImportPath = computed(() =>
  shownSymbol.value?.id === props.symbol?.id ? props.importPath : undefined
);

/** Edits from the panel; a locked symbol follows its rename. */
function onSymbolOp(op: GraphOp): void {
  const lock = locked.value;
  if (lock && op.type === 'renameSymbol') {
    const renamed = (id: string | null): string | null =>
      id === op.symbol ? op.symbol.replace(/[^:.]+$/, op.name) : id;
    locked.value = {
      ...lock,
      symbolId: renamed(lock.symbolId),
      nodeSymbolId: renamed(lock.nodeSymbolId),
    };
  }

  emit('op', op);
}

const index = computed(() => indexDocument(props.doc));
/** Classes, interfaces, type aliases and enums of the file. */
const declaredTypes = computed(() =>
  (props.doc?.symbols ?? [])
    .filter((s) => s.kind === 'class' || s.kind === 'type' || s.kind === 'enum')
    .map((s) => s.name)
);

const selected = computed(() =>
  shownSelection.value
    .map((id) => index.value.nodes.get(id))
    .filter((entry) => entry !== undefined)
);
const single = computed(() =>
  selected.value.length === 1 ? selected.value[0] : undefined
);
/** Entry nodes go with their function (deleted in My Script). */
const deletable = computed(() =>
  selected.value.filter((entry) => entry.node.kind !== 'entry')
);
// Nodes not in the code yet (graph-only) have no place in it.
const location = computed(() =>
  single.value && !single.value.node.graphOnly
    ? lineColumn(props.text, single.value.node.range.start)
    : null
);
const source = computed(() => {
  const node = single.value?.node;
  return node && !node.graphOnly && node.range.end > node.range.start
    ? snippet(props.text, node.range, 24)
    : '';
});

const inputs = computed(
  () => single.value?.node.pins.filter((p) => p.direction === 'in') ?? []
);
const outputs = computed(
  () => single.value?.node.pins.filter((p) => p.direction === 'out') ?? []
);

const stats = computed(() => {
  const fns = props.doc?.functions ?? [];
  return {
    functions: fns.length,
    nodes: fns.reduce((sum, f) => sum + f.nodes.length, 0),
    wires: fns.reduce((sum, f) => sum + f.edges.length, 0),
  };
});

function pinLabel(pin: Pin): string {
  return pin.name || (pin.kind === 'exec' ? 'Exec' : 'Value');
}

function pinExpression(pin: Pin): string {
  const range = pin.range;
  return range && range.end > range.start ? snippet(props.text, range, 2) : '';
}

function commitLiteral(node: GraphNode, pin: Pin, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  if (pin.literal && value !== pin.literal.value) {
    emit('op', { type: 'setLiteral', node: node.id, pin: pin.id, value });
  }
}

function commitComment(node: GraphNode, event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  if (value.trim() !== (node.comment?.text ?? '').trim()) {
    emit('op', { type: 'setComment', node: node.id, text: value });
  }
}

/**
 * Where a symbol's description lives: the comment above its declaration,
 * which is the comment of its entry node (functions, classes) or of its
 * Set node (variables). `undefined`: no such node.
 */
function descriptionOf(
  symbol: ScriptSymbol
): { nodeId: string; text: string } | undefined {
  const doc = props.doc;
  if (!doc) {
    return undefined;
  }

  let node: GraphNode | undefined;
  if (symbol.fnId) {
    node = doc.functions
      .find((f) => f.id === symbol.fnId)
      ?.nodes.find((n) => n.kind === 'entry');
  } else if (['variable', 'constant', 'local'].includes(symbol.kind)) {
    const at = symbol.range.start;
    node = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => {
        const stmt = getMeta<StatementMeta>(n).stmt ?? n.range;
        return n.kind === 'setVar' && stmt.start <= at && at < stmt.end;
      });
  }

  return node ? { nodeId: node.id, text: node.comment?.text ?? '' } : undefined;
}

/** A comment box whose nodes are exactly the selection (title clicked). */
const selectedBox = computed(() => {
  const ids = new Set(shownSelection.value);
  if (ids.size === 0) {
    return undefined;
  }

  return (props.doc?.functions ?? [])
    .flatMap((f) => f.comments ?? [])
    .find(
      (box) =>
        box.nodes.length === ids.size && box.nodes.every((id) => ids.has(id))
    );
});

const boxColor = computed(() =>
  selectedBox.value ? (props.boxColorOf?.(selectedBox.value.id) ?? 0) : 0
);

function renameBox(title: string): void {
  const box = selectedBox.value;
  if (box && title.trim() !== box.title) {
    emit('op', { type: 'renameCommentBox', box: box.id, title: title.trim() });
  }
}

/** Value and type of a symbol in the saved version (reset ↶). */
function baseOf(
  symbol: ScriptSymbol
): { value: string | null; type: string | null } | undefined {
  const base = props.baseDoc?.symbols?.find((s) => s.id === symbol.id);
  const text = props.baseText;
  if (!base || text === undefined) {
    return undefined;
  }

  return {
    value: base.defaultRange
      ? text.slice(base.defaultRange.start, base.defaultRange.end)
      : null,
    type: base.type?.text ?? null,
  };
}

function setSetting(setting: string, value: string): void {
  emit('op', { type: 'setScriptSetting', setting, value });
}

/** Module variables with their values as code (UE's Class Defaults). */
const defaults = computed(() => {
  const code = props.docText ?? props.text;
  return (props.doc?.symbols ?? [])
    .filter(
      (s) =>
        s.scope === '' &&
        (s.kind === 'variable' || s.kind === 'constant') &&
        s.defaultRange
    )
    .map((symbol) => {
      const value = symbol.defaultRange
        ? code.slice(symbol.defaultRange.start, symbol.defaultRange.end)
        : '';
      // Computed values (`greeter(user)`) are no defaults to edit: the
      // graph computes them, like a SET node in UE.
      const computedBy =
        props.doc && !isConstantValue(value) && !fieldValueOf(symbol, value)
          ? declaringNode(props.doc, symbol)?.id
          : undefined;
      return { symbol, value, computedBy };
    });
});

/** Vector, color and enum values have fields: they are constants too. */
function fieldValueOf(symbol: ScriptSymbol, value: string): boolean {
  return (
    fieldValue(
      value.trim(),
      symbol.type?.text ?? String(symbol.dataType),
      props.types ?? null,
      props.doc?.symbols ?? [],
      props.docText ?? props.text
    ) !== undefined
  );
}

function setDefault(symbol: ScriptSymbol, before: string, value: string): void {
  if (value.trim() && value.trim() !== before.trim()) {
    emit('op', {
      type: 'setSymbolValue',
      symbol: symbol.id,
      value: value.trim(),
      kind: 'expression',
    });
  }
}

/** A function that runs on its own (engine callback, signal handler). */
function isEvent(symbol: ScriptSymbol): boolean {
  const fn = props.doc?.functions.find((f) => f.id === symbol.fnId);
  return (
    fn?.nodes.some((n) => n.kind === 'entry' && n.category === 'event') ?? false
  );
}

/** The operator of a selected assignment (`undefined`: no assignment). */
const assignOperator = computed(() => {
  const node = single.value?.node;
  if (
    node?.kind !== 'setVar' ||
    !node.title.startsWith('Set ') ||
    node.meta?.declares !== undefined
  ) {
    return undefined;
  }

  const operator = node.subtitle ?? '=';
  return ASSIGN_OPERATORS.includes(operator) ? operator : undefined;
});

function setAssignOperator(operator: string): void {
  const node = single.value?.node;
  if (node && operator !== assignOperator.value) {
    emit('op', { type: 'setAssignOperator', node: node.id, operator });
  }
}

function deleteSelection(): void {
  emit('op', {
    type: 'deleteNodes',
    nodeIds: deletable.value.map((entry) => entry.node.id),
  });
}
</script>

<template>
  <aside
    data-ui="details-panel"
    class="flex h-full min-h-0 flex-col bg-zinc-950 text-sm"
    aria-label="Details"
  >
    <!-- Like UE: search the details, lock them to the current selection. -->
    <div
      data-ui="details-toolbar"
      class="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-800 px-1.5"
    >
      <input
        v-model="query"
        type="search"
        class="input min-w-0 flex-1 py-1 text-xs"
        placeholder="Search details"
        aria-label="Search details"
      />
      <button
        type="button"
        class="btn-ghost px-1.5"
        :class="{ 'text-amber-400': locked }"
        :title="
          locked
            ? 'Unlock: show what is selected'
            : 'Lock: keep showing this selection'
        "
        :aria-pressed="locked !== null"
        @click="toggleLock"
      >
        <span
          :class="locked ? 'i-mdi-lock' : 'i-mdi-lock-open-variant-outline'"
        />
      </button>
      <button
        v-if="closable"
        type="button"
        class="btn-ghost px-1.5"
        title="Hide panel"
        @click="emit('close')"
      >
        <span class="i-mdi-close" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- UE's comment box details: its title and color. -->
      <DetailsSection
        v-if="selectedBox && !shownSymbol"
        id="comment-box"
        title="Comment box"
      >
        <dl
          class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1.5 px-3 text-xs"
        >
          <dt class="text-zinc-500">Title</dt>
          <dd>
            <input
              :key="`${selectedBox.id}:${selectedBox.title}`"
              class="input py-1 text-xs"
              :value="selectedBox.title"
              :readonly="!editable"
              placeholder="Comment"
              aria-label="Comment box title"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
              @change="renameBox(($event.target as HTMLInputElement).value)"
            />
          </dd>
          <dt class="text-zinc-500">Color</dt>
          <dd class="flex flex-wrap gap-1" role="radiogroup" aria-label="Color">
            <button
              v-for="(swatch, index) in COMMENT_BOX_COLORS"
              :key="swatch.name"
              type="button"
              role="radio"
              class="size-5 rounded border"
              :class="
                boxColor === index
                  ? 'border-amber-400 ring-1 ring-amber-400'
                  : 'border-zinc-700 hover:border-zinc-400'
              "
              :style="{
                background: swatch.color || 'var(--colors-zinc-700)',
              }"
              :title="swatch.name"
              :aria-label="swatch.name"
              :aria-checked="boxColor === index"
              :disabled="!editable"
              @click="emit('boxColor', selectedBox.id, index)"
            />
          </dd>
        </dl>
      </DetailsSection>

      <SymbolDetails
        v-if="shownSymbol"
        :symbol="shownSymbol"
        :description="descriptionOf(shownSymbol)"
        :base="baseOf(shownSymbol)"
        :symbols="doc?.symbols ?? []"
        :doc="doc"
        :event="isEvent(shownSymbol)"
        :text="docText ?? text"
        :uses="shownUses"
        :editable="editable"
        :types="types ?? null"
        :declared="declaredTypes"
        :language="doc?.language ?? ''"
        :import-path="shownImportPath"
        @reveal="(range) => emit('reveal', range)"
        @select="(ids) => emit('select', ids)"
        @op="onSymbolOp"
        @open="emit('openSymbol', shownSymbol.id)"
        @open-import="emit('openImport', shownSymbol.id)"
      />

      <!-- Details of the selection -->
      <template v-else-if="single">
        <template v-if="shownNodeSymbol">
          <SymbolDetails
            :symbol="shownNodeSymbol"
            :description="descriptionOf(shownNodeSymbol)"
            :base="baseOf(shownNodeSymbol)"
            :symbols="doc?.symbols ?? []"
            :doc="doc"
            :text="docText ?? text"
            :uses="0"
            :editable="editable"
            :types="types ?? null"
            :declared="declaredTypes"
            :language="doc?.language ?? ''"
            compact
            @reveal="(range) => emit('reveal', range)"
            @select="(ids) => emit('select', ids)"
            @op="onSymbolOp"
          />
          <h3 class="section-title border-b border-zinc-800/80 pt-3">Node</h3>
        </template>
        <div
          class="border-b border-zinc-800 px-3 py-2.5"
          :style="{
            boxShadow: `inset 3px 0 0 ${CATEGORY_COLORS[single.node.category]}`,
          }"
        >
          <div class="font-semibold text-zinc-50">{{ single.node.title }}</div>
          <div v-if="single.node.subtitle" class="text-xs italic text-zinc-400">
            {{ single.node.subtitle }}
          </div>
        </div>

        <DetailsSection
          v-if="single.node.comment || editable"
          id="node-comment"
          title="Comment"
        >
          <div class="px-3">
            <textarea
              :key="single.node.id"
              class="input min-h-14 resize-y text-xs"
              :value="single.node.comment?.text ?? ''"
              :readonly="!editable"
              placeholder="Add a comment above this code…"
              aria-label="Node comment"
              rows="2"
              @change="commitComment(single.node, $event)"
            />
          </div>
        </DetailsSection>

        <DetailsSection id="node-general" title="General">
          <dl class="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 px-3 text-xs">
            <dt class="text-zinc-500">Function</dt>
            <dd class="truncate">
              <button
                type="button"
                class="link"
                @click="emit('selectFunction', single.fn.id)"
              >
                {{ single.fn.name }}
              </button>
            </dd>
            <!-- An assignment's operator: `=`, `+=` … (UE has none). -->
            <template v-if="assignOperator">
              <dt class="text-zinc-500">Operator</dt>
              <dd class="flex flex-wrap gap-1">
                <button
                  v-for="operator in ASSIGN_OPERATORS"
                  :key="operator"
                  type="button"
                  class="rounded px-1.5 py-0.5 font-mono"
                  :class="
                    operator === assignOperator
                      ? 'bg-zinc-700 text-zinc-50'
                      : 'text-zinc-400 hover:bg-zinc-800'
                  "
                  :aria-pressed="operator === assignOperator"
                  :disabled="!editable"
                  @click="setAssignOperator(operator)"
                >
                  {{ operator }}
                </button>
              </dd>
            </template>
            <template v-if="location">
              <dt class="text-zinc-500">Location</dt>
              <dd>
                <button
                  type="button"
                  class="link"
                  @click="emit('activate', single.node.id)"
                >
                  Line {{ location.line }}, col {{ location.column }}
                </button>
              </dd>
            </template>
          </dl>
        </DetailsSection>

        <DetailsSection
          v-if="inputs.length > 0"
          id="node-inputs"
          title="Inputs"
        >
          <div v-for="pin in inputs" :key="pin.id" class="pin-row">
            <div class="flex items-center gap-1.5">
              <PinIcon :pin="pin" :size="9" />
              <span class="text-zinc-200">{{ pinLabel(pin) }}</span>
              <span class="ml-auto text-[11px] text-zinc-500">{{
                pin.kind === 'exec' ? 'exec' : pin.type
              }}</span>
            </div>
            <template v-if="pinPeers(index, single.node.id, pin).length > 0">
              <button
                v-for="(peer, i) in pinPeers(index, single.node.id, pin)"
                :key="i"
                type="button"
                class="link mt-0.5 block truncate text-xs"
                @click="emit('select', [peer.node.id])"
              >
                ← {{ peer.node.title
                }}<span v-if="peer.pin?.name" class="text-zinc-500">
                  · {{ peer.pin.name }}</span
                >
              </button>
            </template>
            <input
              v-else-if="pin.literal"
              :key="`${single.node.id}:${pin.id}:${pin.literal.raw}`"
              class="input mt-1 py-1 font-mono text-xs"
              :value="pin.literal.value"
              :disabled="!editable || !pin.literal.editable"
              :aria-label="`Value of ${pinLabel(pin)}`"
              @change="commitLiteral(single.node, pin, $event)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />
            <code
              v-else-if="pinExpression(pin)"
              class="mt-1 block truncate rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400"
              >{{ pinExpression(pin) }}</code
            >
          </div>
        </DetailsSection>

        <DetailsSection
          v-if="outputs.length > 0"
          id="node-outputs"
          title="Outputs"
        >
          <div v-for="pin in outputs" :key="pin.id" class="pin-row">
            <div class="flex items-center gap-1.5">
              <PinIcon :pin="pin" :size="9" />
              <span class="text-zinc-200">{{ pinLabel(pin) }}</span>
              <span class="ml-auto text-[11px] text-zinc-500">{{
                pin.kind === 'exec' ? 'exec' : pin.type
              }}</span>
            </div>
            <button
              v-for="(peer, i) in pinPeers(index, single.node.id, pin)"
              :key="i"
              type="button"
              class="link mt-0.5 block truncate text-xs"
              @click="emit('select', [peer.node.id])"
            >
              → {{ peer.node.title
              }}<span v-if="peer.pin?.name" class="text-zinc-500">
                · {{ peer.pin.name }}</span
              >
            </button>
          </div>
        </DetailsSection>

        <DetailsSection v-if="source" id="node-source" title="Source">
          <pre
            class="mx-3 overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-[11px] leading-snug text-zinc-300"
            >{{ source }}</pre>
        </DetailsSection>

        <DetailsSection id="node-advanced" title="Advanced" default-collapsed>
          <dl class="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 px-3 text-xs">
            <dt class="text-zinc-500">Kind</dt>
            <dd class="text-zinc-300">
              {{
                [
                  ...new Set([
                    single.node.kind,
                    single.node.purity,
                    single.node.category,
                  ]),
                ].join(' · ')
              }}
            </dd>
            <dt class="text-zinc-500">Node ID</dt>
            <dd
              class="truncate font-mono text-[11px] text-zinc-400"
              :title="single.node.id"
            >
              {{ single.node.id }}
            </dd>
          </dl>
        </DetailsSection>

        <div v-if="editable && single.node.kind !== 'entry'" class="px-3 py-3">
          <button
            type="button"
            class="btn-ghost w-full justify-center text-red-300 hover:bg-red-950/60"
            @click="deleteSelection"
          >
            <span class="i-mdi-delete-outline" /> Delete node
          </button>
        </div>
      </template>

      <template v-else-if="selected.length > 1">
        <section class="section">
          <h3 class="section-title">{{ selected.length }} nodes selected</h3>
          <button
            v-for="entry in selected.slice(0, 200)"
            :key="entry.node.id"
            type="button"
            class="row"
            @click="emit('select', [entry.node.id])"
          >
            <span
              class="inline-block size-2 shrink-0 rounded-sm"
              :style="{ background: CATEGORY_COLORS[entry.node.category] }"
            />
            <span class="truncate">{{ entry.node.title }}</span>
            <span class="ml-auto truncate text-xs text-zinc-500">{{
              entry.fn.name
            }}</span>
          </button>
        </section>
        <div v-if="editable && deletable.length > 0" class="px-3 pb-3">
          <button
            type="button"
            class="btn-ghost w-full justify-center text-red-300 hover:bg-red-950/60"
            @click="deleteSelection"
          >
            <span class="i-mdi-delete-outline" /> Delete
            {{ deletable.length }}
            {{ deletable.length === 1 ? 'node' : 'nodes' }}
          </button>
        </div>
      </template>

      <template v-else>
        <p class="px-3 py-4 text-xs text-zinc-500">
          Select a node to see its details. Select a function or variable in My
          Script to see its type, inputs and uses.
        </p>
        <!-- UE's Class Settings: settings of the whole script. -->
        <DetailsSection
          v-if="doc?.settings && doc.settings.length > 0"
          id="script-settings"
          title="Script"
        >
          <dl
            class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1.5 px-3 text-xs"
          >
            <template v-for="setting in doc.settings" :key="setting.id">
              <dt class="text-zinc-500">{{ setting.label }}</dt>
              <dd>
                <input
                  v-if="setting.kind === 'flag'"
                  type="checkbox"
                  class="accent-amber-500"
                  :checked="setting.value === 'true'"
                  :disabled="!editable"
                  :aria-label="setting.label"
                  @change="
                    setSetting(
                      setting.id,
                      String(($event.target as HTMLInputElement).checked)
                    )
                  "
                />
                <input
                  v-else
                  :key="`${setting.id}:${setting.value}`"
                  class="input py-1 font-mono text-xs"
                  :value="setting.value"
                  :placeholder="setting.placeholder"
                  :readonly="!editable"
                  :aria-label="setting.label"
                  spellcheck="false"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                  @change="
                    setSetting(
                      setting.id,
                      ($event.target as HTMLInputElement).value
                    )
                  "
                />
              </dd>
            </template>
          </dl>
        </DetailsSection>

        <!-- UE's Class Defaults: the values of all variables in one place. -->
        <DetailsSection
          v-if="defaults.length > 0"
          id="script-defaults"
          title="Defaults"
        >
          <dl
            class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1.5 px-3 text-xs"
          >
            <template v-for="variable in defaults" :key="variable.symbol.id">
              <dt class="min-w-0">
                <button
                  type="button"
                  class="link block max-w-full truncate font-mono"
                  :title="`Show ${variable.symbol.name}`"
                  @click="emit('selectSymbol', variable.symbol.id)"
                >
                  {{ variable.symbol.name }}
                </button>
              </dt>
              <dd
                v-if="variable.computedBy"
                class="flex min-w-0 items-center gap-1"
              >
                <button
                  type="button"
                  class="link min-w-0 truncate px-1.5 text-left font-mono"
                  :title="`${variable.value}\nComputed in the graph: show its SET node`"
                  @click="emit('select', [variable.computedBy])"
                >
                  {{ variable.value }}
                </button>
                <span class="shrink-0 text-[11px] text-zinc-500">in graph</span>
              </dd>
              <dd v-else class="flex items-center gap-1">
                <input
                  :key="`${variable.symbol.id}:${variable.value}`"
                  class="input py-1 font-mono text-xs"
                  :value="variable.value"
                  :readonly="!editable"
                  :aria-label="`Default value of ${variable.symbol.name}`"
                  spellcheck="false"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                  @change="
                    setDefault(
                      variable.symbol,
                      variable.value,
                      ($event.target as HTMLInputElement).value
                    )
                  "
                />
                <button
                  v-if="
                    editable &&
                    baseOf(variable.symbol) &&
                    (baseOf(variable.symbol)?.value ?? '') !== variable.value
                  "
                  type="button"
                  class="btn-ghost shrink-0 px-1 text-amber-400"
                  :title="`Reset to the saved value (${baseOf(variable.symbol)?.value ?? 'none'})`"
                  :aria-label="`Reset ${variable.symbol.name}`"
                  @click="
                    setDefault(
                      variable.symbol,
                      variable.value,
                      baseOf(variable.symbol)?.value ?? ''
                    )
                  "
                >
                  <span class="i-mdi-restore" />
                </button>
              </dd>
            </template>
          </dl>
        </DetailsSection>

        <DetailsSection id="file" title="File">
          <dl class="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 px-3 text-xs">
            <dt class="text-zinc-500">Language</dt>
            <dd>{{ doc?.language ?? '—' }}</dd>
            <dt class="text-zinc-500">Functions</dt>
            <dd>{{ stats.functions }}</dd>
            <dt class="text-zinc-500">Nodes</dt>
            <dd>{{ stats.nodes }}</dd>
            <dt class="text-zinc-500">Wires</dt>
            <dd>{{ stats.wires }}</dd>
          </dl>
        </DetailsSection>
        <DetailsSection
          v-if="doc && doc.diagnostics.length > 0"
          id="file-problems"
          title="Problems"
        >
          <p
            v-for="(d, i) in doc.diagnostics"
            :key="i"
            class="px-3 py-0.5 text-xs text-red-300"
          >
            Line {{ lineColumn(text, d.range.start).line }}: {{ d.message }}
          </p>
        </DetailsSection>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.section {
  @apply border-b border-zinc-800/80 py-2;
}

.section-title {
  @apply px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500;
}

.row {
  @apply flex w-full items-center gap-2 px-3 py-1 text-left text-zinc-300 hover:bg-zinc-800/70;
}

.pin-row {
  @apply px-3 py-1.5;
}

.link {
  @apply text-left text-sky-300 hover:text-sky-200 hover:underline;
}

.badge {
  @apply rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300;
}
</style>
