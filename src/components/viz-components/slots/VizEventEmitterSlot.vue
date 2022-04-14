<script lang="ts">
import Icon from '@/components/Icon.vue';
import * as store from '@/store';
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'VizEventEmitterSlot',
  components: { Icon },
  props: {
    nodeId: { type: String, required: true },
    connected: { type: Boolean, required: true },
  },
  setup(props) {
    const startConnection: (payload: PointerEvent) => void = (payload) => {
      store.startConnection({
        type: 'event',
        startNodeId: props.nodeId,
        startPosition: { x: payload.x, y: payload.y },
      });
    };

    return { startConnection };
  },
});
</script>

<template lang="pug">
icon(v-if="connected", :size="48", @pointerdown="startConnection") mdi-arrow-right-bold
icon(v-else, :size="48", @pointerdown="startConnection") mdi-arrow-right-bold-outline
</template>
