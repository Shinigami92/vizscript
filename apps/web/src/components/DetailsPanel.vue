<script setup lang="ts">
import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  Pin,
  ScriptSymbol,
  SourceRange,
} from '@vizscript/core';
import { CATEGORY_COLORS } from '@vizscript/core';
import { computed } from 'vue';
import { indexDocument, pinPeers } from '../graph/doc-index';
import { lineColumn, snippet } from '../graph/source';
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
}>();

const emit = defineEmits<{
  select: [ids: string[]];
  selectFunction: [fnId: string];
  activate: [id: string];
  reveal: [range: SourceRange];
  openSymbol: [id: string];
  op: [op: GraphOp];
  close: [];
}>();

const index = computed(() => indexDocument(props.doc));

const selected = computed(() =>
  props.selection
    .map((id) => index.value.nodes.get(id))
    .filter((entry) => entry !== undefined)
);
const single = computed(() =>
  selected.value.length === 1 ? selected.value[0] : undefined
);
const location = computed(() =>
  single.value ? lineColumn(props.text, single.value.node.range.start) : null
);
const source = computed(() => {
  const node = single.value?.node;
  return node && node.range.end > node.range.start
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

function deleteSelection(): void {
  emit('op', { type: 'deleteNodes', nodeIds: [...props.selection] });
}
</script>

<template>
  <aside
    class="flex h-full min-h-0 flex-col bg-zinc-950 text-sm"
    aria-label="Details"
  >
    <div
      v-if="closable"
      class="flex h-9 shrink-0 items-center justify-end border-b border-zinc-800 px-1.5"
    >
      <button
        type="button"
        class="btn-ghost px-1.5"
        title="Hide panel"
        @click="emit('close')"
      >
        <span class="i-mdi-close" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <SymbolDetails
        v-if="symbol"
        :symbol="symbol"
        :text="text"
        :uses="symbolUses ?? 0"
        @reveal="(range) => emit('reveal', range)"
        @open="emit('openSymbol', symbol.id)"
      />

      <!-- Details of the selection -->
      <template v-else-if="single">
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
          <div class="mt-1.5 flex flex-wrap gap-1 text-[11px]">
            <span class="badge">{{ single.node.kind }}</span>
            <span class="badge">{{ single.node.purity }}</span>
            <span class="badge">{{ single.node.category }}</span>
          </div>
        </div>

        <section v-if="single.node.comment || editable" class="section">
          <h3 class="section-title">Comment</h3>
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
        </section>

        <section class="section">
          <h3 class="section-title">General</h3>
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
            <dt class="text-zinc-500">Node ID</dt>
            <dd
              class="truncate font-mono text-[11px] text-zinc-400"
              :title="single.node.id"
            >
              {{ single.node.id }}
            </dd>
          </dl>
        </section>

        <section v-if="inputs.length > 0" class="section">
          <h3 class="section-title">Inputs</h3>
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
        </section>

        <section v-if="outputs.length > 0" class="section">
          <h3 class="section-title">Outputs</h3>
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
        </section>

        <section v-if="source" class="section">
          <h3 class="section-title">Source</h3>
          <pre
            class="mx-3 overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-[11px] leading-snug text-zinc-300"
            >{{ source }}</pre>
        </section>

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
        <div v-if="editable" class="px-3 pb-3">
          <button
            type="button"
            class="btn-ghost w-full justify-center text-red-300 hover:bg-red-950/60"
            @click="deleteSelection"
          >
            <span class="i-mdi-delete-outline" /> Delete {{ selected.length }}
            nodes
          </button>
        </div>
      </template>

      <template v-else>
        <p class="px-3 py-4 text-xs text-zinc-500">
          Select a node to see its details. Select a function or variable in My
          Script to see its type, inputs and uses.
        </p>
        <section class="section">
          <h3 class="section-title">File</h3>
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
        </section>
        <section v-if="doc && doc.diagnostics.length > 0" class="section">
          <h3 class="section-title">Problems</h3>
          <p
            v-for="(d, i) in doc.diagnostics"
            :key="i"
            class="px-3 py-0.5 text-xs text-red-300"
          >
            Line {{ lineColumn(text, d.range.start).line }}: {{ d.message }}
          </p>
        </section>
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
