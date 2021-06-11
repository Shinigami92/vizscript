<template lang="pug">
viz-node.viz-set.shape(v-model="internalModelValue")
  template(v-slot:header)
    .header
      .title SET
  template(v-slot:default)
    .body(v-if="internalModelValue.model")
      .inputs
        viz-event-receiver-slot(:connected="eventReceiverConnected")
        viz-input-slot(:title="modelValue.valueSlot.name", :connected="modelValue.valueSlot.connected")
        viz-input-slot(:title="modelValue.targetSlot.name", :connected="modelValue.targetSlot.connected")
      .outputs
        viz-event-emitter-slot(:node-id="internalModelValue.model?.id", :connected="eventEmitterConnected")
        viz-output-slot(
          :node-id="internalModelValue.model?.id",
          :slot-number="0",
          :title="modelValue.resultSlot.name",
          :connected="modelValue.resultSlot.connected"
        )
</template>

<script lang="ts">
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import VizEventReceiverSlot from '@/components/viz-components/slots/VizEventReceiverSlot.vue';
import VizInputSlot from '@/components/viz-components/slots/VizInputSlot.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import { isSetNode, VizSetNode } from '@/shared/viz-components/nodes/VizSetNode';
import { computed, ComputedRef, defineComponent, PropType, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizSet',
  components: { VizNode, VizEventReceiverSlot, VizEventEmitterSlot, VizInputSlot, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizSetNode>, required: true } },
  emits: { 'update:modelValue': isSetNode as EmitType<VizSetNode> },
  setup(props, { emit }) {
    const internalModelValue: WritableComputedRef<VizSetNode> = useVModelValue(props, emit);
    const eventReceiverConnected: ComputedRef<boolean> = computed(() => props.modelValue.eventReceiverConnected);
    const eventEmitterConnected: ComputedRef<boolean> = computed(() => props.modelValue.eventEmitterConnected);
    return { internalModelValue, eventReceiverConnected, eventEmitterConnected };
  }
});
</script>

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
