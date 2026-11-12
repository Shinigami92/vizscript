<script setup lang="ts">
import type { ScriptSymbol, SourceRange } from '@vizscript/core';
import { pinColor } from '@vizscript/core';
import { computed } from 'vue';
import { useTheme } from '../composables/use-theme';
import { lineColumn, snippet } from '../graph/source';
import { SYMBOL_ICONS, SYMBOL_LABELS, symbolType } from '../graph/symbols';

/** Details of a symbol selected in "My Script" (UE: the Details panel). */
const props = defineProps<{
  symbol: ScriptSymbol;
  text: string;
  /** Number of nodes using the symbol (highlighted in the graph). */
  uses: number;
}>();

const emit = defineEmits<{
  reveal: [range: SourceRange];
  open: [];
}>();

const { scheme } = useTheme();
const type = computed(() => symbolType(props.symbol));
const location = computed(() =>
  lineColumn(props.text, props.symbol.nameRange.start)
);
const source = computed(() => snippet(props.text, props.symbol.range, 16));

function code(range: SourceRange | undefined): string {
  return range ? props.text.slice(range.start, range.end) : '';
}

function color(dataType: string): string {
  return pinColor(dataType, scheme.value);
}
</script>

<template>
  <div>
    <div class="border-b border-zinc-800 px-3 py-2.5">
      <div class="flex items-center gap-2">
        <span :class="SYMBOL_ICONS[symbol.kind]" />
        <span class="truncate font-semibold text-zinc-50">{{
          symbol.name
        }}</span>
      </div>
      <div class="mt-0.5 text-xs text-zinc-400">
        {{ SYMBOL_LABELS[symbol.kind]
        }}<template v-if="symbol.scope"> in {{ symbol.scope }}</template>
      </div>
    </div>

    <section class="section">
      <dl class="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1.5 px-3 text-xs">
        <template v-if="!symbol.params">
          <dt class="text-zinc-500">Type</dt>
          <dd class="flex min-w-0 items-center gap-1.5 font-mono">
            <span
              class="size-2 shrink-0 rounded-full"
              :style="{ background: color(String(symbol.dataType)) }"
            />
            <span
              class="truncate"
              :class="type.inferred ? 'text-zinc-500 italic' : 'text-zinc-200'"
              >{{ type.text }}</span
            >
            <span v-if="type.inferred" class="font-sans text-zinc-600"
              >(inferred)</span
            >
          </dd>
        </template>
        <template v-if="symbol.defaultRange">
          <dt class="text-zinc-500">
            {{ symbol.kind === 'local' ? 'Value' : 'Default value' }}
          </dt>
          <dd class="truncate font-mono text-zinc-200">
            {{ code(symbol.defaultRange) }}
          </dd>
        </template>
        <template v-if="symbol.extends">
          <dt class="text-zinc-500">Extends</dt>
          <dd class="truncate font-mono text-zinc-200">{{ symbol.extends }}</dd>
        </template>
        <template v-if="symbol.modifiers.length > 0">
          <dt class="text-zinc-500">Modifiers</dt>
          <dd class="flex flex-wrap gap-1">
            <span
              v-for="modifier in symbol.modifiers"
              :key="modifier"
              class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
              >{{ modifier }}</span
            >
          </dd>
        </template>
        <dt class="text-zinc-500">Location</dt>
        <dd>
          <button
            type="button"
            class="text-left text-sky-300 hover:text-sky-200 hover:underline"
            @click="emit('reveal', symbol.nameRange)"
          >
            Line {{ location.line }}, column {{ location.column }}
          </button>
        </dd>
        <template v-if="symbol.kind !== 'type' && symbol.kind !== 'enum'">
          <dt class="text-zinc-500">Used by</dt>
          <dd class="text-zinc-300">
            {{ uses }} node{{ uses === 1 ? '' : 's' }}
            <span v-if="uses > 0" class="text-zinc-500">(highlighted)</span>
          </dd>
        </template>
      </dl>
    </section>

    <section v-if="symbol.params" class="section">
      <h3 class="section-title">Inputs</h3>
      <p v-if="symbol.params.length === 0" class="px-3 text-xs text-zinc-500">
        No parameters.
      </p>
      <div
        v-for="param in symbol.params"
        :key="param.name"
        class="flex items-center gap-2 px-3 py-1 text-xs"
      >
        <span
          class="size-2.5 shrink-0 rounded-full border-2"
          :style="{ borderColor: color(String(param.dataType)) }"
        />
        <span class="min-w-0 truncate font-mono text-zinc-200"
          >{{ param.rest ? '…' : '' }}{{ param.name }}</span
        >
        <span
          class="ml-auto truncate font-mono"
          :class="param.type ? 'text-zinc-400' : 'text-zinc-600 italic'"
          >{{ param.type?.text ?? param.dataType }}</span
        >
        <span
          v-if="param.defaultRange"
          class="max-w-24 shrink-0 truncate font-mono text-zinc-500"
          :title="code(param.defaultRange)"
          >= {{ code(param.defaultRange) }}</span
        >
      </div>
    </section>

    <section
      v-if="symbol.kind === 'function' || symbol.kind === 'method'"
      class="section"
    >
      <h3 class="section-title">Output</h3>
      <div class="flex items-center gap-2 px-3 py-1 text-xs">
        <span
          class="size-2.5 shrink-0 rounded-full border-2"
          :style="{ borderColor: color(String(symbol.returnType ?? 'any')) }"
        />
        <span
          class="font-mono"
          :class="symbol.returns ? 'text-zinc-200' : 'text-zinc-600 italic'"
          >{{ symbol.returns?.text ?? 'not declared' }}</span
        >
      </div>
    </section>

    <section class="section">
      <h3 class="section-title">Source</h3>
      <pre
        class="mx-3 overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-[11px] leading-snug text-zinc-300"
        >{{ source }}</pre>
    </section>

    <div v-if="symbol.fnId" class="px-3 py-3">
      <button
        type="button"
        class="btn-ghost w-full justify-center border border-zinc-800"
        @click="emit('open')"
      >
        <span class="i-mdi-graph-outline" /> Show in graph
      </button>
    </div>
  </div>
</template>

<style scoped>
.section {
  @apply border-b border-zinc-800/80 py-2;
}

.section-title {
  @apply px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500;
}
</style>
