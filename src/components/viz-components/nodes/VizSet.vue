<script setup lang="ts">
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import VizEventReceiverSlot from '@/components/viz-components/slots/VizEventReceiverSlot.vue';
import VizInputSlot from '@/components/viz-components/slots/VizInputSlot.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizSetNode } from '@/shared/viz-components/nodes/VizSetNode';
import { isSetNode } from '@/shared/viz-components/nodes/VizSetNode';
import { computed } from 'vue';

const props = defineProps<{
  modelValue: VizSetNode;
}>();

const emit = defineEmits({
  'update:modelValue': isSetNode as EmitType<VizSetNode>,
});

const modelValue = useVModelValue(props, emit);

const eventReceiverConnected = computed(
  () => props.modelValue.eventReceiverConnected,
);
const eventEmitterConnected = computed(
  () => props.modelValue.eventEmitterConnected,
);
</script>

<template lang="pug">
VizNode.viz-set.shape(v-model="modelValue")
  template(#header)
    .header
      .title SET
  template(#default)
    .body(v-if="modelValue.model")
      .inputs
        VizEventReceiverSlot(:connected="eventReceiverConnected")
        VizInputSlot(
          :connected="modelValue.valueSlot.connected",
          :title="modelValue.valueSlot.name"
        )
        VizInputSlot(
          :connected="modelValue.targetSlot.connected",
          :title="modelValue.targetSlot.name"
        )
      .outputs
        VizEventEmitterSlot(
          :connected="eventEmitterConnected",
          :node-id="modelValue.model?.id"
        )
        VizOutputSlot(
          :connected="modelValue.resultSlot.connected",
          :node-id="modelValue.model?.id",
          :slot-number="0",
          :title="modelValue.resultSlot.name"
        )
</template>

<style lang="postcss" scoped>
.viz-set.shape {
  @apply max-w-64;
  @apply grid grid-rows-[48px,1fr];
  @apply text-primary-50;

  .header {
    @apply flex items-center justify-center;
    @apply rounded-t;
    @apply bg-green-300 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;

    .title {
      @apply text-xl text-primary-50;
    }
  }

  .body {
    @apply grid grid-cols-[1fr,1fr];
    @apply justify-between;
    @apply rounded-b;
    @apply bg-background-400 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;

    .inputs {
      @apply flex flex-col items-start;
    }

    .outputs {
      @apply flex flex-col items-end;
    }
  }
}
</style>
