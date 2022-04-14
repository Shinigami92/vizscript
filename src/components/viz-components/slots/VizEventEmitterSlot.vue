<script lang="ts" setup>
import Icon from '@/components/Icon.vue';
import * as store from '@/store';

const props = defineProps<{
  nodeId: string;
  connected: boolean;
}>();

function startConnection(payload: PointerEvent): void {
  store.startConnection({
    type: 'event',
    startNodeId: props.nodeId,
    startPosition: { x: payload.x, y: payload.y },
  });
}
</script>

<template lang="pug">
Icon(v-if="connected", :size="48", @pointerdown="startConnection") mdi-arrow-right-bold
Icon(v-else, :size="48", @pointerdown="startConnection") mdi-arrow-right-bold-outline
</template>
