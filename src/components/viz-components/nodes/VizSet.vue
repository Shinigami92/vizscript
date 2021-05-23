<template lang="pug">
.viz-node.viz-set.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown'
)
  .header
    .title SET
  .body
    .inputs
      viz-event-receiver-slot(:connected='eventReceiverConnected')
      viz-input-slot(title='value')
      viz-input-slot(title='target')
    .outputs
      viz-event-emitter-slot(:connected='eventEmitterConnected')
      viz-output-slot(title='result')
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import VizEventReceiverSlot from '@/components/viz-components/slots/VizEventReceiverSlot.vue';
import VizInputSlot from '@/components/viz-components/slots/VizInputSlot.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { UsePositionable, usePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import { isSetNode, VizSetNode } from '@/shared/viz-components/nodes/VizSetNode';
import { computed, ComputedRef, defineComponent, PropType } from 'vue';
export default defineComponent({
  name: 'VizSet',
  components: { Icon, VizEventReceiverSlot, VizEventEmitterSlot, VizInputSlot, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizSetNode>, required: true } },
  emits: { 'update:modelValue': isSetNode as EmitType<VizSetNode> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizSetNode> = usePositionable(props, emit);
    const eventReceiverConnected: ComputedRef<boolean> = computed(() => props.modelValue.eventReceiverConnected);
    const eventEmitterConnected: ComputedRef<boolean> = computed(() => props.modelValue.eventEmitterConnected);
    return { ...positionable, eventReceiverConnected, eventEmitterConnected };
  }
});
</script>

<style lang="postcss" scoped>
.viz-node {
  @apply absolute rounded shadow z-10;
}

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
