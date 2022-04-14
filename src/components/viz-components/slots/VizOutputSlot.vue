<script lang="ts" setup>
import Icon from '@/components/Icon.vue';
import * as store from '@/store';

const props = defineProps<{
  nodeId: string;
  slotNumber: number;
  title: string;
  connected: boolean;
}>();

const startConnection: (payload: PointerEvent) => void = (payload) => {
  store.startConnection({
    type: 'slot',
    startNodeId: props.nodeId,
    startSlot: props.slotNumber,
    startPosition: { x: payload.x, y: payload.y },
  });
};
</script>

<template lang="pug">
.viz-output-slot.shape
  .title {{ title }}
  Icon(v-if="connected", @pointerdown="startConnection") mdi-circle
  Icon(v-else, @pointerdown="startConnection") mdi-circle-outline
</template>

<style lang="postcss" scoped>
.viz-output-slot.shape {
  @apply my-1 px-2 min-w-20 flex items-end;

  .title {
    @apply mr-2 text-base text-primary-50;
  }
}
</style>
