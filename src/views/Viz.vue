<template lang="pug">
.relative.overflow-hidden.h-full
  .text-3xl.text-primary-400 Viz
  viz-event-start
  viz-function(title='greeter', v-model:x='x', v-model:y='y')
</template>

<script lang="ts">
import VizEventStart from '@/components/viz-components/VizEventStart.vue';
import VizFunction from '@/components/viz-components/VizFunction.vue';
import { defineComponent, Ref, ref } from 'vue';
export default defineComponent({
  components: { VizEventStart, VizFunction },
  setup() {
    const x: Ref<number> = ref(0);
    const y: Ref<number> = ref(0);
    return { x, y };
  }
});
</script>
