<script setup lang="ts">
import type {
  GraphOp,
  ScriptSymbol,
  SourceRange,
  TypeSystemInfo,
  ValueKind,
} from '@vizscript/core';
import { pinColor } from '@vizscript/core';
import { computed, ref, watch } from 'vue';
import { useTheme } from '../composables/use-theme';
import { lineColumn, snippet } from '../graph/source';
import { SYMBOL_ICONS, SYMBOL_LABELS, symbolType } from '../graph/symbols';
import TypePicker from './TypePicker.vue';

/** Details of a symbol selected in "My Script" (UE: the Details panel). */
const props = defineProps<{
  symbol: ScriptSymbol;
  text: string;
  /** Number of nodes using the symbol (highlighted in the graph). */
  uses: number;
  editable: boolean;
  /** Types and modifiers of the language (from the parser worker). */
  types: TypeSystemInfo | null;
  /** Types declared in the file, for the type picker. */
  declared: ReadonlyArray<string>;
  language: string;
}>();

const emit = defineEmits<{
  reveal: [range: SourceRange];
  open: [];
  op: [op: GraphOp];
}>();

const { scheme } = useTheme();
const type = computed(() => symbolType(props.symbol));
const location = computed(() =>
  lineColumn(props.text, props.symbol.nameRange.start)
);
const source = computed(() => snippet(props.text, props.symbol.range, 16));
const isVariable = computed(() =>
  ['variable', 'constant', 'local'].includes(props.symbol.kind)
);

function code(range: SourceRange | undefined): string {
  return range ? props.text.slice(range.start, range.end) : '';
}

function color(dataType: string): string {
  return pinColor(dataType, scheme.value);
}

// ------------------------------------------------------------ value editor

const valueCode = computed(() => code(props.symbol.defaultRange).trim());

/** The text of a simple string literal (`"a"`, `'b'`), else `undefined`. */
function stringValue(literal: string): string | undefined {
  const match = literal.match(/^([&^]?)(["'])((?:\\.|(?!\2).)*)\2$/s);
  if (!match) {
    return undefined;
  }

  return (match[3] ?? '').replaceAll(/\\(.)/g, (_, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char
  );
}

const BOOLEANS = new Set(['true', 'false', 'True', 'False']);

/** How the value is edited: like UE, the widget follows the type. */
const valueKind = computed<ValueKind>(() => {
  const dataType = String(props.symbol.dataType);
  const current = valueCode.value;
  if (dataType === 'bool' && (current === '' || BOOLEANS.has(current))) {
    return 'bool';
  }

  if (
    dataType === 'number' &&
    (current === '' || /^[-+]?[\d_.]+(?:e[-+]?\d+)?$/i.test(current))
  ) {
    return 'number';
  }

  if (
    dataType === 'string' &&
    (current === '' || stringValue(current) !== undefined)
  ) {
    return 'string';
  }

  return 'expression';
});

const draft = ref('');
watch(
  [valueCode, valueKind],
  () => {
    draft.value =
      valueKind.value === 'string'
        ? (stringValue(valueCode.value) ?? '')
        : valueCode.value;
  },
  { immediate: true }
);

function commitValue(): void {
  const current =
    valueKind.value === 'string'
      ? stringValue(valueCode.value)
      : valueCode.value;
  // `v-model` on a number field gives a number.
  const next = String(draft.value);
  if (next === current) {
    return;
  }

  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: next === '' && valueKind.value !== 'string' ? null : next,
    kind: valueKind.value,
  });
}

function setBoolean(event: Event): void {
  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: String((event.target as HTMLInputElement).checked),
    kind: 'bool',
  });
}

function clearValue(): void {
  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: null,
    kind: 'expression',
  });
}

function setType(typeText: string | null, defaultValue?: string): void {
  emit('op', {
    type: 'setSymbolType',
    symbol: props.symbol.id,
    typeText,
    ...(defaultValue === undefined ? {} : { defaultValue }),
  });
}

// --------------------------------------------------------------- modifiers

/** Keywords and switches the language offers for this kind of symbol. */
const modifierOptions = computed(() => {
  const modifiers = props.types?.modifiers;
  if (!modifiers || !isVariable.value) {
    return undefined;
  }

  // GDScript: the script's members are its variables, not class members.
  const member =
    props.symbol.scope !== '' &&
    props.symbol.kind !== 'local' &&
    !(props.language === 'gdscript' && props.symbol.scope === '');
  const kind =
    props.symbol.kind === 'local'
      ? 'local'
      : member
        ? 'member'
        : props.symbol.kind === 'constant'
          ? 'constant'
          : 'variable';
  return modifiers[kind];
});

function hasModifier(modifier: string): boolean {
  return props.symbol.modifiers.includes(modifier);
}

function setModifier(modifier: string, enabled: boolean): void {
  emit('op', {
    type: 'setModifier',
    symbol: props.symbol.id,
    modifier,
    enabled,
  });
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
          <dt class="pt-0.5 text-zinc-500">Type</dt>
          <dd class="min-w-0">
            <TypePicker
              v-if="types && isVariable"
              :value="symbol.type?.text ?? null"
              :data-type="symbol.dataType"
              :types="types"
              :declared="declared"
              :editable="editable"
              @change="setType"
            />
            <span
              v-else
              class="flex min-w-0 items-center gap-1.5 px-1.5 font-mono"
            >
              <span
                class="size-2 shrink-0 rounded-full"
                :style="{ background: color(String(symbol.dataType)) }"
              />
              <span
                class="truncate"
                :class="
                  type.inferred ? 'text-zinc-500 italic' : 'text-zinc-200'
                "
                >{{ type.text }}</span
              >
            </span>
          </dd>
        </template>
        <template v-if="isVariable">
          <dt class="pt-1 text-zinc-500">
            {{ symbol.kind === 'local' ? 'Value' : 'Default value' }}
          </dt>
          <dd class="flex min-w-0 items-center gap-1">
            <template v-if="!editable">
              <span class="truncate px-1.5 font-mono text-zinc-200">{{
                valueCode || '—'
              }}</span>
            </template>
            <label
              v-else-if="valueKind === 'bool'"
              class="flex cursor-pointer items-center gap-1.5 px-1.5 py-0.5"
            >
              <input
                type="checkbox"
                class="accent-amber-500"
                :checked="valueCode === 'true' || valueCode === 'True'"
                :aria-label="`Value of ${symbol.name}`"
                @change="setBoolean"
              />
              <span class="font-mono text-zinc-300">{{
                valueCode || 'no value'
              }}</span>
            </label>
            <input
              v-else
              v-model="draft"
              class="input py-0.5 text-xs"
              :class="valueKind === 'string' ? '' : 'font-mono'"
              :type="valueKind === 'number' ? 'number' : 'text'"
              :placeholder="valueKind === 'string' ? 'Text' : 'No value'"
              :aria-label="`Value of ${symbol.name}`"
              spellcheck="false"
              @keydown.enter.prevent="commitValue"
              @blur="commitValue"
            />
            <button
              v-if="editable && symbol.defaultRange"
              type="button"
              class="btn-ghost shrink-0 px-1"
              title="Remove the value"
              aria-label="Remove the value"
              @click="clearValue"
            >
              <span class="i-mdi-close" />
            </button>
          </dd>
        </template>
        <template v-if="modifierOptions?.keywords">
          <dt class="pt-1 text-zinc-500">Declaration</dt>
          <dd
            class="flex flex-wrap gap-1"
            role="group"
            aria-label="Declaration"
          >
            <button
              v-for="keyword in modifierOptions.keywords"
              :key="keyword"
              type="button"
              class="rounded px-2 py-0.5 font-mono"
              :class="
                hasModifier(keyword)
                  ? 'bg-zinc-700 text-zinc-50'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              "
              :aria-pressed="hasModifier(keyword)"
              :disabled="!editable"
              @click="setModifier(keyword, true)"
            >
              {{ keyword }}
            </button>
          </dd>
        </template>
        <template v-if="modifierOptions?.flags">
          <dt class="pt-0.5 text-zinc-500">Modifiers</dt>
          <dd class="flex flex-wrap gap-x-3 gap-y-1">
            <label
              v-for="flag in modifierOptions.flags"
              :key="flag"
              class="flex cursor-pointer items-center gap-1.5 font-mono text-zinc-300"
            >
              <input
                type="checkbox"
                class="accent-amber-500"
                :checked="hasModifier(flag)"
                :disabled="!editable"
                @change="
                  setModifier(flag, ($event.target as HTMLInputElement).checked)
                "
              />
              {{ flag }}
            </label>
          </dd>
        </template>
        <template v-if="symbol.extends">
          <dt class="text-zinc-500">Extends</dt>
          <dd class="truncate font-mono text-zinc-200">{{ symbol.extends }}</dd>
        </template>
        <template v-if="symbol.modifiers.length > 0 && !modifierOptions">
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
