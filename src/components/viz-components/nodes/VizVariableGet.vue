<script setup lang="ts">
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizVariableGetNode } from '@/shared/viz-components/nodes/VizVariableGetNode';
import { isVariableGetNode } from '@/shared/viz-components/nodes/VizVariableGetNode';
import type { WritableComputedRef } from 'vue';

const props = defineProps<{
  modelValue: VizVariableGetNode;
}>();

const emit = defineEmits({
  'update:modelValue': isVariableGetNode as EmitType<VizVariableGetNode>,
});

const modelValue = useVModelValue(props, emit);
</script>

<template lang="pug">
VizNode.viz-function.shape(v-model="modelValue")
  template(#default)
    .body(v-if="modelValue.model")
      .outputs
        VizOutputSlot(
          :connected="modelValue.outputSlot.connected",
          :node-id="modelValue.model?.id",
          :slot-number="0",
          :title="modelValue.outputSlot.name"
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
