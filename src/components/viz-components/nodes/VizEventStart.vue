<template lang="pug">
viz-node.viz-event-start.shape(v-model="internalModelValue")
  template(v-slot:header)
    .header
      icon(:size="32") mdi-arrow-right-bold-hexagon-outline
      .title Event Start
  template(v-slot:default)
    .body(v-if="internalModelValue.model")
      viz-event-emitter-slot(:node-id="internalModelValue.model?.id", :connected="connected")
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import { isEventStartNode, VizEventStartNode } from '@/shared/viz-components/nodes/VizEventStartNode';
import { computed, defineComponent, PropType, Ref, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizEventStart',
  components: { Icon, VizNode, VizEventEmitterSlot },
  props: { modelValue: { type: Object as PropType<VizEventStartNode>, required: true } },
  emits: { 'update:modelValue': isEventStartNode as EmitType<VizEventStartNode> },
  setup(props, { emit }) {
    const internalModelValue: WritableComputedRef<VizEventStartNode> = useVModelValue(props, emit);
    const connected: Ref<boolean> = computed(() => props.modelValue.connected);
    return { internalModelValue, connected };
  }
});
</script>

<style lang="postcss" scoped>
.viz-event-start.shape {
  @apply w-48;
  @apply grid grid-rows-[48px,1fr];
  @apply text-primary-50;

  .header {
    @apply flex items-center;
    @apply rounded-t;
    @apply bg-red-400 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;

    .icon {
      @apply mx-2;
    }

    .title {
      @apply text-xl;
    }
  }

  .body {
    @apply flex items-center justify-end;
    @apply rounded-b;
    @apply bg-background-400 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;
  }
}
</style>
