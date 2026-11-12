<script setup lang="ts">
import { useElementBounding, useWindowSize } from '@vueuse/core';
import { computed, useTemplateRef } from 'vue';
import type { DocIndex } from '../graph/doc-index';
import { describeType, pinPeers } from '../graph/doc-index';
import type { Problem } from '../graph/problems';
import { lineColumn, snippet } from '../graph/source';
import PinIcon from './PinIcon.vue';

const props = defineProps<{
  index: DocIndex;
  text: string;
  nodeId: string;
  pinId: string | null;
  /** Client coordinates of the pointer. */
  x: number;
  y: number;
  /** Problems reported for the node. */
  problems?: ReadonlyArray<Problem>;
}>();

const card = useTemplateRef<HTMLDivElement>('card');
const { width, height } = useElementBounding(card);
const viewport = useWindowSize();

const entry = computed(() => props.index.nodes.get(props.nodeId));
const pin = computed(() =>
  props.pinId
    ? entry.value?.node.pins.find((p) => p.id === props.pinId)
    : undefined
);
const peers = computed(() =>
  pin.value ? pinPeers(props.index, props.nodeId, pin.value) : []
);
const location = computed(() =>
  entry.value ? lineColumn(props.text, entry.value.node.range.start) : null
);
const code = computed(() => {
  const node = entry.value?.node;
  if (!node || node.kind === 'entry' || node.range.end <= node.range.start) {
    return '';
  }

  return snippet(props.text, node.range, 6);
});
const pinCode = computed(() => {
  const range = pin.value?.range;
  return range && range.end > range.start ? snippet(props.text, range, 3) : '';
});

const position = computed(() => {
  const gap = 16;
  const left =
    props.x + gap + width.value > viewport.width.value
      ? props.x - gap - width.value
      : props.x + gap;
  const top =
    props.y + gap + height.value > viewport.height.value
      ? props.y - gap - height.value
      : props.y + gap;
  return { left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` };
});

const KIND_LABELS: Record<string, string> = {
  entry: 'Event / function entry',
  return: 'Return',
  call: 'Function call',
  operator: 'Operator (pure)',
  template: 'Text template (pure)',
  literal: 'Literal (pure)',
  makeObject: 'Make object (pure)',
  makeArray: 'Make array (pure)',
  getProperty: 'Get property (pure)',
  getVar: 'Get variable (pure)',
  setVar: 'Set variable',
  functionRef: 'Function reference',
  branch: 'Flow control: branch',
  switch: 'Flow control: switch',
  forEach: 'Flow control: for each',
  loop: 'Flow control: loop',
  break: 'Break',
  continue: 'Continue',
  try: 'Flow control: try / catch',
  throw: 'Throw',
  await: 'Latent: await',
  select: 'Select (pure)',
  export: 'Module export',
  unknown: 'Unrecognized code',
};
</script>

<template>
  <div
    v-if="entry"
    data-ui="node-tooltip"
    ref="card"
    role="tooltip"
    class="pointer-events-none fixed z-30 max-w-sm rounded-lg border border-zinc-700 bg-zinc-900/97 p-2.5 text-xs text-zinc-300 shadow-2xl"
    :style="position"
  >
    <ul v-if="problems && problems.length > 0" class="mb-2 space-y-1">
      <li
        v-for="(problem, i) in problems.slice(0, 4)"
        :key="i"
        class="flex gap-1.5"
        :class="
          problem.severity === 'error' ? 'text-red-300' : 'text-amber-300'
        "
      >
        <span
          class="mt-0.5 shrink-0"
          :class="
            problem.severity === 'error' ? 'i-mdi-close-circle' : 'i-mdi-alert'
          "
        />
        <span class="whitespace-pre-wrap">{{ problem.message }}</span>
      </li>
    </ul>
    <template v-if="pin">
      <div class="flex items-center gap-2">
        <PinIcon :pin="pin" :size="10" />
        <span class="font-semibold text-zinc-100">{{
          pin.name || (pin.kind === 'exec' ? 'Exec' : 'Value')
        }}</span>
        <span class="text-zinc-500"
          >{{ pin.direction === 'in' ? 'input' : 'output' }} ·
          {{ describeType(pin) }}</span
        >
      </div>
      <div v-if="pin.literal" class="mt-1.5">
        Value:
        <code class="rounded bg-zinc-800 px-1 font-mono text-zinc-100">{{
          pin.literal.raw
        }}</code>
      </div>
      <div v-if="peers.length > 0" class="mt-1.5 space-y-0.5">
        <div v-for="(peer, i) in peers.slice(0, 5)" :key="i">
          {{ pin.direction === 'in' ? '← from' : '→ to' }}
          <span class="text-zinc-100">{{ peer.node.title }}</span>
          <span v-if="peer.pin?.name" class="text-zinc-500">
            · {{ peer.pin.name }}</span
          >
        </div>
        <div v-if="peers.length > 5" class="text-zinc-500">
          +{{ peers.length - 5 }} more
        </div>
      </div>
      <div
        v-else-if="!pin.literal && pin.direction === 'in'"
        class="mt-1.5 text-zinc-500"
      >
        Not connected
      </div>
      <pre
        v-if="pinCode && !pin.literal"
        class="mt-2 max-h-24 overflow-hidden whitespace-pre rounded bg-zinc-950 p-1.5 font-mono text-[11px] text-zinc-300"
        >{{ pinCode }}</pre>
    </template>

    <template v-else>
      <div class="font-semibold text-zinc-100">{{ entry.node.title }}</div>
      <div v-if="entry.node.subtitle" class="italic text-zinc-400">
        {{ entry.node.subtitle }}
      </div>
      <div class="mt-1 text-zinc-500">
        {{ KIND_LABELS[entry.node.kind] ?? entry.node.kind }}
        · {{ entry.fn.name }}
        <template v-if="location"> · line {{ location.line }}</template>
      </div>
      <pre
        v-if="code"
        class="mt-2 max-h-40 overflow-hidden whitespace-pre rounded bg-zinc-950 p-1.5 font-mono text-[11px] leading-snug text-zinc-300"
        >{{ code }}</pre>
      <div class="mt-1.5 text-[11px] text-zinc-500">
        Double-click to jump to code · right-click for actions
      </div>
    </template>
  </div>
</template>
