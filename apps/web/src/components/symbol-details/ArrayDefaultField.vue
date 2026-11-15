<script setup lang="ts">
import type {
  GraphNode,
  GraphOp,
  ScriptSymbol,
  TypeSystemInfo,
} from '@vizscript/core';
import { arrayElements } from '@vizscript/core';
import { inject, ref, shallowRef, watch } from 'vue';
import ArrayValueField from '../value-fields/ArrayValueField.vue';
import type { ParsedValue } from './parse-value';
import { PARSE_VALUE } from './parse-value';

/**
 * The default of an array input, edited like a variable's array (UE's
 * array rows): it is no node, so it is parsed in a host file and its ops
 * are `inValue`. Without a default, ⊕ starts an empty one; ✕ removes it.
 */
const props = defineProps<{
  symbol: ScriptSymbol;
  index: number;
  text: string;
  editable: boolean;
  types: TypeSystemInfo | null;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
}>();

const parseValue = inject(PARSE_VALUE, undefined);
const parsed = shallowRef<ParsedValue | null>(null);
const node = shallowRef<GraphNode | undefined>(undefined);
const failed = ref(false);

const param = (): NonNullable<ScriptSymbol['params']>[number] | undefined =>
  props.symbol.params?.[props.index];

watch(
  () => {
    const range = param()?.defaultRange;
    return range ? props.text.slice(range.start, range.end) : null;
  },
  async (code) => {
    const range = param()?.defaultRange;
    if (code === null || !range || !parseValue) {
      parsed.value = null;
      node.value = undefined;
      return;
    }

    const next = await parseValue(range, param()?.type?.text);
    parsed.value = next;
    node.value = next?.doc.functions
      .flatMap((f) => f.nodes)
      .find(
        (n) =>
          n.kind === 'makeArray' &&
          n.range.start === next.start &&
          arrayElements(n) !== undefined
      );
    failed.value = node.value === undefined;
  },
  { immediate: true }
);

function setDefault(value: string | null): void {
  emit('op', {
    type: 'setParameterValue',
    symbol: props.symbol.id,
    index: props.index,
    value,
    kind: 'expression',
  });
}

function inValue(op: GraphOp): void {
  const range = param()?.defaultRange;
  if (range) {
    emit('op', {
      type: 'inValue',
      range,
      ...(param()?.type ? { typeText: param()?.type?.text } : {}),
      op,
    });
  }
}
</script>

<template>
  <ArrayValueField
    v-if="parsed && node"
    :doc="parsed.doc"
    :text="parsed.text"
    :node="node"
    :editable="editable"
    :types="types"
    clearable
    @op="inValue"
    @clear="setDefault(types?.containerDefaults?.array ?? '[]')"
  >
    <template #label><slot name="label" /></template>
    <template #actions>
      <button
        v-if="editable"
        type="button"
        class="btn-ghost shrink-0 px-1"
        title="Remove the default"
        aria-label="Remove the default"
        @click="setDefault(null)"
      >
        <span class="i-mdi-close" />
      </button>
    </template>
  </ArrayValueField>
  <div
    v-else-if="!param()?.defaultRange"
    class="flex min-w-0 flex-1 items-center gap-1"
  >
    <slot name="label" />
    <span class="px-1 text-zinc-500">none</span>
    <button
      v-if="editable"
      type="button"
      class="btn-ghost ml-auto px-1"
      title="Add a default (an empty array)"
      aria-label="Add a default"
      @click="setDefault(types?.containerDefaults?.array ?? '[]')"
    >
      <span class="i-mdi-plus-circle-outline" />
    </button>
  </div>
  <div v-else-if="failed" class="flex min-w-0 flex-1 items-center gap-1">
    <slot name="label" />
    <slot />
  </div>
</template>
