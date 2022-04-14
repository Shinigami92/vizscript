<script lang="ts" setup>
import { usePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizNode } from '@/shared/viz-components/nodes/VizNode';
import { isNode } from '@/shared/viz-components/nodes/VizNode';
import { onMounted, ref } from 'vue';

const props = defineProps<{
  modelValue: VizNode;
}>();

const emit = defineEmits({
  'update:modelValue': isNode as EmitType<VizNode>,
});

const { dx, dy, onPointerdown } = usePositionable(props, emit);
const node = ref<HTMLDivElement>();

onMounted(() =>
  emit('update:modelValue', {
    ...props.modelValue,
    vizNodeDivRef: node.value,
  }),
);
</script>

<template lang="pug">
.viz-node(
  ref="node",
  :style="{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }",
  @pointerdown="onPointerdown"
)
  slot(name="header")
  slot
</template>

<style lang="postcss" scoped>
.viz-node {
  @apply absolute rounded shadow select-none z-10;
}
</style>
