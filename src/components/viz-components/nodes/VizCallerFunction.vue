<template lang="pug">
viz-node.viz-caller-function.shape(v-model="internalModelValue")
  template(v-slot:header)
    .header
      icon(:size="32") mdi-math-integral
      .title {{ modelValue.title }}
  template(v-slot:default)
    .body(v-if="internalModelValue.model")
      .inputs
        viz-event-receiver-slot(:connected="eventReceiverConnected")
        viz-input-slot(:title="modelValue.callerSlot.name", :connected="modelValue.callerSlot.connected")
        viz-input-slot(
          v-for="slot in modelValue.inputSlots",
          :key="slot.name",
          :title="slot.name",
          :connected="slot.connected"
        )
      .outputs
        viz-event-emitter-slot(:node-id="internalModelValue.model?.id", :connected="eventEmitterConnected")
        viz-output-slot(
          :node-id="internalModelValue.model?.id",
          :slot-number="0",
          :title="modelValue.returnSlot.name",
          :connected="modelValue.returnSlot.connected"
        )
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import VizEventReceiverSlot from '@/components/viz-components/slots/VizEventReceiverSlot.vue';
import VizInputSlot from '@/components/viz-components/slots/VizInputSlot.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import { isCallerFunctionNode, VizCallerFunctionNode } from '@/shared/viz-components/nodes/VizCallerFunctionNode';
import { computed, ComputedRef, defineComponent, PropType, WritableComputedRef } from 'vue';

export default defineComponent({
  name: 'VizCallerFunction',
  components: { Icon, VizNode, VizEventReceiverSlot, VizEventEmitterSlot, VizInputSlot, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizCallerFunctionNode>, required: true } },
  emits: { 'update:modelValue': isCallerFunctionNode as EmitType<VizCallerFunctionNode> },
  setup(props, { emit }) {
    const internalModelValue: WritableComputedRef<VizCallerFunctionNode> = useVModelValue(props, emit);

    const eventReceiverConnected: ComputedRef<boolean> = computed(() => props.modelValue.eventReceiverConnected);
    const eventEmitterConnected: ComputedRef<boolean> = computed(() => props.modelValue.eventEmitterConnected);

    return { internalModelValue, eventReceiverConnected, eventEmitterConnected };
  }
});
</script>

<style lang="postcss" scoped>
.viz-caller-function.shape {
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
