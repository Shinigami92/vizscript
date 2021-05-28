<template lang="pug">
viz-node.viz-function.shape(v-model='internalModelValue')
  template(v-slot:default)
    .body
      .outputs
        viz-output-slot(:title='modelValue.outputSlot.name', :connected='modelValue.outputSlot.connected')
</template>

<script lang="ts">
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import { isVariableGetNode, VizVariableGetNode } from '@/shared/viz-components/nodes/VizVariableGetNode';
import { defineComponent, PropType, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizVariableGet',
  components: { VizNode, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizVariableGetNode>, required: true } },
  emits: { 'update:modelValue': isVariableGetNode as EmitType<VizVariableGetNode> },
  setup(props, { emit }) {
    const internalModelValue: WritableComputedRef<VizVariableGetNode> = useVModelValue(props, emit);
    return { internalModelValue };
  }
});
</script>

<style lang="postcss" scoped>
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
