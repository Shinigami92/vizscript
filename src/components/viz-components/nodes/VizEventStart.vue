<template lang="pug">
.viz-node.viz-event-start.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown'
)
  .header
    icon(:size='32') mdi-arrow-right-bold-hexagon-outline
    .title Event Start
  .body
    viz-event-emitter-slot(:connected='connected')
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import { usePositionable, UsePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import { isEventStartNode, VizEventStartNode } from '@/shared/viz-components/nodes/VizEventStartNode';
import { computed, defineComponent, PropType, Ref } from 'vue';
export default defineComponent({
  name: 'VizEventStart',
  components: { Icon, VizEventEmitterSlot },
  props: { modelValue: { type: Object as PropType<VizEventStartNode>, required: true } },
  emits: { 'update:modelValue': isEventStartNode as EmitType<VizEventStartNode> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizEventStartNode> = usePositionable(props, emit);
    const connected: Ref<boolean> = computed(() => props.modelValue.connected);
    return { ...positionable, connected };
  }
});
</script>

<style lang="postcss" scoped>
.viz-node {
  @apply absolute rounded shadow z-10;
}

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
