<script setup lang="ts">
import type {
  GraphDocument,
  GraphOp,
  ScriptSymbol,
  TypeSystemInfo,
  ValueKind,
} from '@vizscript/core';
import { arrayElements, fieldValue, isConstantValue } from '@vizscript/core';
import { computed, ref, watch } from 'vue';
import NumberField from '../NumberField.vue';
import PinType from '../PinType.vue';
import ArrayValueField from '../value-fields/ArrayValueField.vue';
import ValueFields from '../ValueFields.vue';
import { PLACEHOLDER_VALUES, stringValue, valueKindOf } from './value-kinds';

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
  /** The name links to the variable (Defaults lists several). */
  linked?: boolean;
  /** The parsed file: an array literal is edited element by element. */
  doc?: GraphDocument | null;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
  /** Select the SET node that computes the value. */
  showNode: [];
  /** Show the variable (its linked name). */
  selectSymbol: [];
}>();

const isVariable = computed(() =>
  ['variable', 'constant', 'local'].includes(props.symbol.kind)
);

const valueCode = computed(() => {
  const range = props.symbol.defaultRange;
  return (range ? props.text.slice(range.start, range.end) : '').trim();
});

/** How the value is edited: like UE, the widget follows the type. */
const valueKind = computed<ValueKind>(() =>
  valueKindOf(props.symbol.dataType, valueCode.value)
);

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
    // An empty field of an untyped value takes text unless it is code.
    kind:
      valueKind.value === 'expression' && current === ''
        ? 'auto'
        : valueKind.value,
  });
}

/** The field holds code (a name, a call): not text, written as it is. */
const showsCode = computed(
  () =>
    valueKind.value === 'expression' &&
    valueCode.value !== '' &&
    placeholderValue.value === ''
);

/** The Make Array of an array literal value (UE: an array's elements). */
const arrayNode = computed(() => {
  const range = props.symbol.defaultRange;
  if (!range || !props.doc) {
    return undefined;
  }

  const node = props.doc.functions
    .flatMap((f) => f.nodes)
    .find(
      (n) =>
        n.kind === 'makeArray' &&
        n.range.start === range.start &&
        n.range.end === range.end
    );
  return node && arrayElements(node) ? node : undefined;
});

function clearArray(): void {
  emit('op', {
    type: 'setSymbolValue',
    symbol: props.symbol.id,
    value: props.types?.containerDefaults?.array ?? '[]',
    kind: 'expression',
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

/**
 * A value computed when the code runs (`greeter(user)`), not a constant
 * like UE's Default Value: the graph computes it, so it is shown, not
 * edited here.
 */
const computedValue = computed(
  () =>
    isVariable.value &&
    valueKind.value === 'expression' &&
    placeholderValue.value === '' &&
    fields.value === undefined &&
    !isConstantValue(valueCode.value)
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
  <!-- An array: one row over both columns, its elements get the width. -->
  <div v-if="arrayNode && doc" class="col-span-2 min-w-0">
    <ArrayValueField
      :doc="doc"
      :text="text"
      :node="arrayNode"
      :editable="editable"
      :types="types"
      clearable
      @op="emit('op', $event)"
      @clear="clearArray"
    >
      <template #label>
        <button
          v-if="linked"
          type="button"
          class="link mr-1 w-[6.5rem] shrink-0 truncate text-left font-mono"
          :title="`Show ${symbol.name}`"
          @click="emit('selectSymbol')"
        >
          {{ symbol.name }}
        </button>
        <span
          v-else
          class="mr-1 w-[6.5rem] shrink-0 truncate font-mono text-zinc-500"
          :title="symbol.name"
          >{{ symbol.name }}</span
        >
      </template>
      <template #actions>
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
        <PinType :type="symbol.dataType" />
      </template>
    </ArrayValueField>
  </div>
  <template v-else>
    <!-- Named after the variable, like UE's Default Value rows. -->
    <dt v-if="linked" class="min-w-0">
      <button
        type="button"
        class="link block max-w-full truncate font-mono"
        :title="`Show ${symbol.name}`"
        @click="emit('selectSymbol')"
      >
        {{ symbol.name }}
      </button>
    </dt>
    <dt
      v-else
      class="truncate pt-1 font-mono text-zinc-500"
      :title="symbol.name"
    >
      {{ symbol.name }}
    </dt>
    <dd class="flex min-w-0 items-center gap-1">
      <template v-if="computedValue">
        <button
          type="button"
          class="link min-w-0 truncate px-1.5 text-left font-mono"
          :title="`${valueCode}\nComputed in the graph: show its SET node`"
          @click="emit('showNode')"
        >
          {{ valueCode }}
        </button>
        <span class="shrink-0 text-[11px] text-zinc-500">in graph</span>
      </template>
      <template v-else-if="!editable">
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
      <ValueFields
        v-else-if="fields"
        :value="fields"
        :editable="editable"
        :label="`Value of ${symbol.name}`"
        @set="setExpression"
      />
      <NumberField
        v-else-if="valueKind === 'number'"
        :key="`${symbol.id}:number`"
        :value="draft"
        :editable="editable"
        :placeholder="placeholderValue || 'No value'"
        :label="`Value of ${symbol.name}`"
        @commit="
          (value) => {
            draft = value;
            commitValue();
          }
        "
      />
      <input
        v-else
        :key="`${symbol.id}:${valueKind}`"
        v-model="draft"
        class="input py-0.5 text-xs"
        :class="valueKind === 'string' ? '' : 'font-mono'"
        type="text"
        :placeholder="
          placeholderValue || (valueKind === 'string' ? 'Text' : 'No value')
        "
        :aria-label="`Value of ${symbol.name}`"
        spellcheck="false"
        @keydown.enter.prevent="commitValue"
        @blur="commitValue"
      />
      <span
        v-if="editable && showsCode && !computedValue && !fields"
        class="shrink-0 text-[11px] text-zinc-500"
        title="Written as code, as it is: put text in quotes"
        >code</span
      >
      <button
        v-if="
          editable &&
          symbol.defaultRange &&
          !computedValue &&
          symbol.kind !== 'constant'
        "
        type="button"
        class="btn-ghost shrink-0 px-1"
        title="Remove the value"
        aria-label="Remove the value"
        @click="clearValue"
      >
        <span class="i-mdi-close" />
      </button>
      <button
        v-if="editable && valueChanged && !computedValue"
        type="button"
        class="btn-ghost shrink-0 px-1 text-amber-400"
        :title="`Reset to the saved value (${base?.value ?? 'none'})`"
        aria-label="Reset the value"
        @click="resetValue"
      >
        <span class="i-mdi-restore" />
      </button>
      <PinType :type="symbol.dataType" />
    </dd>
  </template>
</template>
