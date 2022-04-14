<script lang="ts">
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizVariableGetNode } from '@/shared/viz-components/nodes/VizVariableGetNode';
import { isVariableGetNode } from '@/shared/viz-components/nodes/VizVariableGetNode';
import type { PropType, WritableComputedRef } from 'vue';
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'VizVariableGet',
  components: { VizNode, VizOutputSlot },
  props: {
    modelValue: {
      type: Object as PropType<VizVariableGetNode>,
      required: true,
    },
  },
  emits: {
    'update:modelValue': isVariableGetNode as EmitType<VizVariableGetNode>,
  },
  setup(props, { emit }) {
    const internalModelValue: WritableComputedRef<VizVariableGetNode> =
      useVModelValue(props, emit);

    return { internalModelValue };
  },
});
</script>

<template lang="pug">
VizNode.viz-function.shape(v-model="internalModelValue")
  template(v-slot:default)
    .body(v-if="internalModelValue.model")
      .outputs
        VizOutputSlot(
          :node-id="internalModelValue.model?.id",
          :slot-number="0",
          :title="modelValue.outputSlot.name",
          :connected="modelValue.outputSlot.connected"
        )
</template>

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
