<script setup lang="ts">
import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  Pin,
  TypeSystemInfo,
} from '@vizscript/core';
import { arrayElements, inputSource } from '@vizscript/core';
import { computed } from 'vue';
import NumberField from '../NumberField.vue';
import ArrayValueField from './ArrayValueField.vue';

/**
 * The value of one input in an array or object of the Details panel: a
 * widget for its literal (number, text, true / false), a nested array, or
 * its code when the graph computes it.
 */
const props = defineProps<{
  doc: GraphDocument;
  text: string;
  node: GraphNode;
  pin: Pin;
  editable: boolean;
  types: TypeSystemInfo | null;
  label: string;
}>();

const emit = defineEmits<{
  op: [op: GraphOp];
}>();

const source = computed(() => inputSource(props.doc, props.node, props.pin));
const nestedArray = computed(() =>
  source.value && arrayElements(source.value) ? source.value : undefined
);
const literal = computed(() => (source.value ? undefined : props.pin.literal));
const code = computed(() => {
  const range = source.value?.range ?? props.pin.range;
  return range ? props.text.slice(range.start, range.end) : '';
});

function set(value: string): void {
  if (literal.value && value !== literal.value.value) {
    emit('op', {
      type: 'setLiteral',
      node: props.node.id,
      pin: props.pin.id,
      value,
    });
  }
}
</script>

<template>
  <ArrayValueField
    v-if="nestedArray"
    :doc="doc"
    :text="text"
    :node="nestedArray"
    :editable="editable"
    :types="types"
    @op="emit('op', $event)"
  />
  <NumberField
    v-else-if="literal?.kind === 'number'"
    :value="literal.value"
    :editable="editable && literal.editable"
    :label="label"
    @commit="set"
  />
  <label
    v-else-if="literal?.kind === 'boolean'"
    class="flex cursor-pointer items-center gap-1.5 px-1 py-0.5"
  >
    <input
      type="checkbox"
      class="accent-amber-500"
      :checked="literal.value === 'true'"
      :disabled="!editable || !literal.editable"
      :aria-label="label"
      @change="set(String(($event.target as HTMLInputElement).checked))"
    />
    <span class="font-mono text-zinc-300">{{ literal.raw }}</span>
  </label>
  <input
    v-else-if="literal"
    :key="literal.raw"
    class="input py-0.5 text-xs"
    :class="literal.kind === 'string' ? '' : 'font-mono'"
    :value="literal.value"
    :readonly="!editable || !literal.editable"
    :aria-label="label"
    spellcheck="false"
    @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
    @change="set(($event.target as HTMLInputElement).value)"
  />
  <code
    v-else
    class="block truncate px-1 py-0.5 font-mono text-zinc-400"
    :title="`${code}\nComputed in the graph`"
    >{{ code }}</code
  >
</template>
