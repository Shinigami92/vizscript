<template lang="pug">
.viz-set.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown',
  @mousemove='onMousemove',
  @mouseup='onMouseup'
)
  .header
    .title SET
  .body
    .inputs
      icon(:size='48') mdi-arrow-right-bold-outline
      viz-input-slot(title='value')
      viz-input-slot(title='target')
    .outputs
      icon(:size='48') mdi-arrow-right-bold-outline
      viz-output-slot(title='result')
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizInputSlot from '@/components/viz-components/slots/VizInputSlot.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { UsePositionable, usePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import { isSetNode, VizSetNode } from '@/shared/viz-components/nodes/VizSetNode';
import { defineComponent, PropType } from 'vue';
export default defineComponent({
  name: 'VizSet',
  components: { Icon, VizInputSlot, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizSetNode>, required: true } },
  emits: { 'update:modelValue': isSetNode as EmitType<VizSetNode> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizSetNode> = usePositionable(props, emit);
    return { ...positionable };
  }
});
</script>

<style lang="postcss" scoped>
.viz-set.shape {
  @apply absolute max-w-64 grid grid-rows-[48px,1fr] rounded shadow text-primary-50 bg-background-400;

  .header {
    @apply flex items-center justify-center rounded-t bg-green-300;

    .title {
      @apply text-xl text-primary-50;
    }
  }

  .body {
    @apply grid grid-cols-[1fr,1fr] justify-between rounded-b bg-background-400;

    .inputs {
      @apply flex flex-col items-start;
    }

    .outputs {
      @apply flex flex-col items-end;
    }
  }
}
</style>
