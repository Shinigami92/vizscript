<template lang="pug">
viz-node.viz-build-in-get.shape(v-model="internalModelValue")
  template(v-slot:default)
    .body(v-if="internalModelValue.model")
      icon.mx-2 mdi-cards-diamond
      .outputs
        viz-output-slot(
          :node-id="internalModelValue.model?.id",
          :slot-number="0",
          :title="modelValue.outputSlot.name",
          :connected="modelValue.outputSlot.connected"
        )
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import { isBuildInGetNode, VizBuildInGetNode } from '@/shared/viz-components/nodes/VizBuildInGetNode';
import { defineComponent, PropType, WritableComputedRef } from 'vue';

export default defineComponent({
  name: 'VizBuildInGet',
  components: { Icon, VizNode, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizBuildInGetNode>, required: true } },
  emits: { 'update:modelValue': isBuildInGetNode as EmitType<VizBuildInGetNode> },
  setup(props, { emit }) {
    const internalModelValue: WritableComputedRef<VizBuildInGetNode> = useVModelValue(props, emit);

    return { internalModelValue };
  }
});
</script>

<style lang="postcss" scoped>
.viz-build-in-get.shape {
  @apply min-w-32 text-primary-50;

  .body {
    @apply rounded;
    @apply bg-background-400 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;
    @apply flex items-center;

    .outputs {
      @apply ml-4 flex flex-col items-end;
    }
  }
}
</style>
