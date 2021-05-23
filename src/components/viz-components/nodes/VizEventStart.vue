<template lang="pug">
.viz-event-start.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown'
)
  .header
    icon(:size='32') mdi-arrow-right-bold-hexagon-outline
    .title Event Start
  .body
    icon(:size='48') mdi-arrow-right-bold-outline
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import { usePositionable, UsePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import { isEventStartNode, VizEventStartNode } from '@/shared/viz-components/nodes/VizEventStartNode';
import { defineComponent, PropType } from 'vue';
export default defineComponent({
  name: 'VizEventStart',
  components: { Icon },
  props: { modelValue: { type: Object as PropType<VizEventStartNode>, required: true } },
  emits: { 'update:modelValue': isEventStartNode as EmitType<VizEventStartNode> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizEventStartNode> = usePositionable(props, emit);
    return { ...positionable };
  }
});
</script>

<style lang="postcss" scoped>
.viz-event-start.shape {
  @apply absolute w-48 grid grid-rows-[48px,1fr] rounded shadow text-primary-50 bg-background-400;

  .header {
    @apply flex items-center rounded-t bg-red-400;

    .icon {
      @apply mx-2 text-primary-50;
    }

    .title {
      @apply text-xl text-primary-50;
    }
  }

  .body {
    @apply flex items-center justify-end rounded-b bg-background-400;
  }
}
</style>
