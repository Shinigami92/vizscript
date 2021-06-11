<template lang="pug">
.viz-output-slot.shape
  .title {{ title }}
  icon(v-if="connected", @pointerdown="startConnection") mdi-circle
  icon(v-else, @pointerdown="startConnection") mdi-circle-outline
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import * as store from '@/store';
import { defineComponent } from 'vue';
export default defineComponent({
  name: 'VizOutputSlot',
  components: { Icon },
  props: {
    nodeId: { type: String, required: true },
    slotNumber: { type: Number, required: true },
    title: { type: String, required: true },
    connected: { type: Boolean, required: true }
  },
  setup(props) {
    const startConnection: (payload: PointerEvent) => void = (payload) => {
      store.startConnection({
        type: 'slot',
        startNodeId: props.nodeId,
        startSlot: props.slotNumber,
        startPosition: { x: payload.x, y: payload.y }
      });
    };
    return { startConnection };
  }
});
</script>

<style lang="postcss" scoped>
.viz-output-slot.shape {
  @apply my-1 px-2 min-w-20 flex items-end;

  .title {
    @apply mr-2 text-base text-primary-50;
  }
}
</style>
