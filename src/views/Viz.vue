<template lang="pug">
.relative.overflow-hidden.h-full
  .text-3xl.text-primary-400 Viz
  viz-event-start
  viz-function(v-model='greeterFunction')
</template>

<script lang="ts">
import VizEventStart from '@/components/viz-components/VizEventStart.vue';
import VizFunction from '@/components/viz-components/VizFunction.vue';
import type { VizFunctionModel } from '@/shared/VizFunction';
import { defineComponent, Ref, ref } from 'vue';
export default defineComponent({
  components: { VizEventStart, VizFunction },
  setup() {
    const greeterFunction: Ref<VizFunctionModel> = ref({ title: 'greeter', x: 0, y: 0 });
    return { greeterFunction };
  }
});
</script>
