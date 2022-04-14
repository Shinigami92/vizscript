<template lang="pug">
.viz-node(
  ref="node",
  :style="{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }",
  @pointerdown="onPointerdown"
)
  slot(name="header")
  slot
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import type { UsePositionable } from '@/composables/usePositionable';
import { usePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizNode } from '@/shared/viz-components/nodes/VizNode';
import { isNode } from '@/shared/viz-components/nodes/VizNode';
import type { PropType, Ref } from 'vue';
import { defineComponent, onMounted, ref } from 'vue';

export default defineComponent({
  name: 'VizNode',
  components: { Icon },
  props: { modelValue: { type: Object as PropType<VizNode>, required: true } },
  emits: { 'update:modelValue': isNode as EmitType<VizNode> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizNode> = usePositionable(props, emit);
    const node: Ref<HTMLDivElement | undefined> = ref();

    onMounted(() =>
      emit('update:modelValue', {
        ...props.modelValue,
        vizNodeDivRef: node.value,
      }),
    );

    return { ...positionable, node };
  },
});
</script>

<style lang="postcss" scoped>
.viz-node {
  @apply absolute rounded shadow select-none z-10;
}
</style>
