<script setup lang="ts">
import type { GraphEdge } from '@vizscript/core';
import { useElementBounding, useWindowSize } from '@vueuse/core';
import { computed, useTemplateRef } from 'vue';
import type { DocIndex } from '../graph/doc-index';
import { wireType } from '../graph/doc-index';

const props = defineProps<{
  index: DocIndex;
  edge: GraphEdge;
  /** Client coordinates of the pointer. */
  x: number;
  y: number;
}>();

const card = useTemplateRef<HTMLDivElement>('card');
const { width, height } = useElementBounding(card);
const viewport = useWindowSize();

const type = computed(() => wireType(props.index, props.edge));
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
</script>

<template>
  <div
    data-ui="wire-tooltip"
    ref="card"
    role="tooltip"
    class="motion-fade pointer-events-none fixed z-30 max-w-sm rounded border border-zinc-700 bg-zinc-900/97 px-2 py-1 text-xs text-zinc-100 shadow-2xl"
    :style="position"
  >
    <div>{{ type.name }}</div>
    <div
      v-if="type.detail"
      class="max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-400"
    >
      {{ type.detail }}
    </div>
  </div>
</template>
