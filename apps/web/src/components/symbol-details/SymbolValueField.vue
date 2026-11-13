<script setup lang="ts">
import type {
  GraphOp,
  ScriptSymbol,
  TypeSystemInfo,
  ValueKind,
} from '@vizscript/core';
import { fieldValue } from '@vizscript/core';
import { computed, ref, watch } from 'vue';
import ValueFields from '../ValueFields.vue';

/** The (default) value row of a variable's details: `<dt>` and `<dd>`. */
const props = defineProps<{
  symbol: ScriptSymbol;
  text: string;
  editable: boolean;
  types: TypeSystemInfo | null;
  /** Symbols of the file (enum members for value choices). */
  symbols?: ReadonlyArray<ScriptSymbol>;
  /** Value in the saved version of the file, for UE's reset ↶. */
  base?: { value: string | null; type: string | null };
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
}>();

const isVariable = computed(() =>
  ['variable', 'constant', 'local'].includes(props.symbol.kind)
);

const valueCode = computed(() => {
  const range = props.symbol.defaultRange;
  return (range ? props.text.slice(range.start, range.end) : '').trim();
});

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

/** `undefined`, `null`, `None`: shown as an empty field, typing replaces it. */
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'undefined',
  'null',
  'None',
]);
const placeholderValue = computed(() =>
  PLACEHOLDER_VALUES.has(valueCode.value.trim()) ? valueCode.value.trim() : ''
);

const draft = ref('');
watch(
  [valueCode, valueKind],
  () => {
    draft.value = placeholderValue.value
      ? ''
      : valueKind.value === 'string'
        ? (stringValue(valueCode.value) ?? '')
        : valueCode.value;
  },
  { immediate: true }
);

/**
 * `220` for a float (its type's default is `0.0`) is written `220.0`, like
 * the code would be.
 */
function floatStyle(value: string): string {
  const defaultValue = props.types?.primitives.find(
    (t) => t.name === props.symbol.type?.text
  )?.defaultValue;
  return valueKind.value === 'number' &&
    /^-?\d[\d_]*$/.test(value) &&
    /^-?\d+\.\d+$/.test(defaultValue ?? '')
    ? `${value}.0`
    : value;
}

function commitValue(): void {
  const current = placeholderValue.value
    ? ''
    : valueKind.value === 'string'
      ? stringValue(valueCode.value)
      : valueCode.value;
  const next = floatStyle(draft.value.trim());
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

/** Vector, color and enum values get fields (`ValueFields`). */
const fields = computed(() =>
  isVariable.value
    ? fieldValue(
        valueCode.value,
        props.symbol.type?.text ?? String(props.symbol.dataType),
        props.types,
        props.symbols ?? [],
        props.text
      )
    : undefined
);

function setExpression(written: string): void {
  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: written,
    kind: 'expression',
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

/** Like UE's ↶: the value differs from the saved version. */
const valueChanged = computed(
  () =>
    props.base !== undefined &&
    isVariable.value &&
    props.base.value !== (valueCode.value || null)
);

function resetValue(): void {
  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: props.base?.value ?? null,
    kind: 'expression',
  });
}
</script>

<template>
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
      <span class="font-mono text-zinc-300">{{ valueCode || 'no value' }}</span>
    </label>
    <ValueFields
      v-else-if="fields"
      :value="fields"
      :editable="editable"
      :label="`Value of ${symbol.name}`"
      @set="setExpression"
    />
    <input
      v-else
      :key="`${symbol.id}:${valueKind}`"
      v-model="draft"
      class="input py-0.5 text-xs"
      :class="valueKind === 'string' ? '' : 'font-mono'"
      type="text"
      :inputmode="valueKind === 'number' ? 'decimal' : undefined"
      :placeholder="
        placeholderValue || (valueKind === 'string' ? 'Text' : 'No value')
      "
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
    <button
      v-if="editable && valueChanged"
      type="button"
      class="btn-ghost shrink-0 px-1 text-amber-400"
      :title="`Reset to the saved value (${base?.value ?? 'none'})`"
      aria-label="Reset the value"
      @click="resetValue"
    >
      <span class="i-mdi-restore" />
    </button>
  </dd>
</template>
