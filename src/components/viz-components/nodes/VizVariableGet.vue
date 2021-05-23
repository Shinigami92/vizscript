<template lang="pug">
.viz-node.viz-function.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown'
)
  .body
    .outputs
      viz-output-slot(:title='modelValue.name')
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { usePositionable, UsePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import { isVariableGetNode, VizVariableGetNode } from '@/shared/viz-components/nodes/VizVariableGetNode';
import { defineComponent, PropType } from 'vue';
export default defineComponent({
  name: 'VizVariableGet',
  components: { Icon, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizVariableGetNode>, required: true } },
  emits: { 'update:modelValue': isVariableGetNode as EmitType<VizVariableGetNode> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizVariableGetNode> = usePositionable(props, emit);
    return { ...positionable };
  }
});
</script>

<style lang="postcss" scoped>
.viz-node {
  @apply absolute rounded shadow z-10;
}

.viz-function.shape {
  @apply min-w-32 text-primary-50;

  .body {
    @apply rounded;
    @apply bg-background-400 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;

    .outputs {
      @apply ml-4 flex flex-col items-end;
    }
  }
}
</style>
