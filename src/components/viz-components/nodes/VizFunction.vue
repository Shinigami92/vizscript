<script lang="ts" setup>
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
import type { ComputedRef, WritableComputedRef } from 'vue';
import { computed } from 'vue';

const props = defineProps<{
  modelValue: VizFunctionNode;
}>();

const emit = defineEmits({
  'update:modelValue': isFunctionNode as EmitType<VizFunctionNode>,
});

const internalModelValue: WritableComputedRef<VizFunctionNode> = useVModelValue(
  props,
  emit,
);

const eventReceiverConnected: ComputedRef<boolean> = computed(
  () => props.modelValue.eventReceiverConnected,
);
const eventEmitterConnected: ComputedRef<boolean> = computed(
  () => props.modelValue.eventEmitterConnected,
);
</script>

<template lang="pug">
VizNode.viz-function.shape(v-model="internalModelValue")
  template(#header)
    .header
      Icon(:size="32") mdi-math-integral
      .title {{ modelValue.title }}
  template(#default)
    .body(v-if="internalModelValue.model")
      .inputs
        VizEventReceiverSlot(:connected="eventReceiverConnected")
        VizInputSlot(
          v-for="slot in modelValue.inputSlots",
          :key="slot.name",
          :title="slot.name",
          :connected="slot.connected"
        )
      .outputs
        VizEventEmitterSlot(
          :node-id="internalModelValue.model?.id",
          :connected="eventEmitterConnected"
        )
        VizOutputSlot(
          :node-id="internalModelValue.model?.id",
          :slot-number="0",
          :title="modelValue.returnSlot.name",
          :connected="modelValue.returnSlot.connected"
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
