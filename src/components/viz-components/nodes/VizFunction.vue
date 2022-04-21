<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import VizEventReceiverSlot from '@/components/viz-components/slots/VizEventReceiverSlot.vue';
import VizInputSlot from '@/components/viz-components/slots/VizInputSlot.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizFunctionNode } from '@/shared/viz-components/nodes/VizFunctionNode';
import { isFunctionNode } from '@/shared/viz-components/nodes/VizFunctionNode';
import { computed } from 'vue';

const props = defineProps<{
  modelValue: VizFunctionNode;
}>();

const emit = defineEmits({
  'update:modelValue': isFunctionNode as EmitType<VizFunctionNode>,
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
VizNode.viz-function.shape(v-model="modelValue")
  template(#header)
    .header
      Icon(:size="32") mdi-math-integral
      .title {{ modelValue.title }}
  template(#default)
    .body(v-if="modelValue.model")
      .inputs
        VizEventReceiverSlot(:connected="eventReceiverConnected")
        VizInputSlot(
          v-for="slot in modelValue.inputSlots",
          :key="slot.name",
          :connected="slot.connected",
          :title="slot.name"
        )
      .outputs
        VizEventEmitterSlot(
          :connected="eventEmitterConnected",
          :node-id="modelValue.model?.id"
        )
        VizOutputSlot(
          :connected="modelValue.returnSlot.connected",
          :node-id="modelValue.model?.id",
          :slot-number="0",
          :title="modelValue.returnSlot.name"
        )
</template>

<style lang="postcss" scoped>
.viz-function.shape {
  @apply max-w-64;
  @apply grid grid-rows-[48px,1fr];
  @apply text-primary-50;

  .header {
    @apply flex items-center;
    @apply rounded-t;
    @apply bg-blue-300 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;

    .icon {
      @apply mx-2;
    }

    .title {
      @apply text-xl ml-2 mr-4;
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
