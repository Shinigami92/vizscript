<script lang="ts" setup>
import Icon from '@/components/Icon.vue';
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizBuildInGetNode } from '@/shared/viz-components/nodes/VizBuildInGetNode';
import { isBuildInGetNode } from '@/shared/viz-components/nodes/VizBuildInGetNode';
import type { WritableComputedRef } from 'vue';

const props = defineProps<{
  modelValue: VizBuildInGetNode;
}>();

const emit = defineEmits({
  'update:modelValue': isBuildInGetNode as EmitType<VizBuildInGetNode>,
});

const internalModelValue: WritableComputedRef<VizBuildInGetNode> =
  useVModelValue(props, emit);
</script>

<template lang="pug">
VizNode.viz-build-in-get.shape(v-model="internalModelValue")
  template(#default)
    .body(v-if="internalModelValue.model")
      Icon.mx-2 mdi-cards-diamond
      .outputs
        VizOutputSlot(
          :node-id="internalModelValue.model?.id",
          :slot-number="0",
          :title="modelValue.outputSlot.name",
          :connected="modelValue.outputSlot.connected"
        )
</template>

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
