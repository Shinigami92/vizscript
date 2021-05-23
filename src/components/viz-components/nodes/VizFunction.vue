<template lang="pug">
.viz-function.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown'
)
  .header
    icon(:size='32') mdi-math-integral
    .title {{ modelValue.title }}
  .body
    .inputs
      icon(:size='48') mdi-arrow-right-bold-outline
      viz-input-slot(title='person')
    .outputs
      icon(:size='48') mdi-arrow-right-bold-outline
      viz-output-slot(title='result')
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizInputSlot from '@/components/viz-components/slots/VizInputSlot.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { usePositionable, UsePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import { isFunctionNode, VizFunctionNode } from '@/shared/viz-components/nodes/VizFunctionNode';
import { defineComponent, PropType } from 'vue';
export default defineComponent({
  name: 'VizFunction',
  components: { Icon, VizInputSlot, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizFunctionNode>, required: true } },
  emits: { 'update:modelValue': isFunctionNode as EmitType<VizFunctionNode> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizFunctionNode> = usePositionable(props, emit);
    return { ...positionable };
  }
});
</script>

<style lang="postcss" scoped>
.viz-function.shape {
  @apply absolute max-w-64 grid grid-rows-[48px,1fr] rounded shadow text-primary-50 bg-background-400;

  .header {
    @apply flex items-center rounded-t bg-blue-300;

    .icon {
      @apply mx-2 text-primary-50;
    }

    .title {
      @apply text-xl ml-2 mr-4 text-primary-50;
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
