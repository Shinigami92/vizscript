<template lang="pug">
.relative.overflow-hidden.h-full
  .text-3xl.text-primary-400 Viz
  viz-event-start
  viz-function(v-model='greeterFunction')
  viz-set(v-model='setFunction')
</template>

<script lang="ts">
import VizEventStart from '@/components/viz-components/VizEventStart.vue';
import VizFunction from '@/components/viz-components/VizFunction.vue';
import VizSet from '@/components/viz-components/VizSet.vue';
import type { VizFunctionModel } from '@/shared/VizFunctionModel';
import type { VizSetModel } from '@/shared/VizSetModel';
import { defineComponent, Ref, ref } from 'vue';
export default defineComponent({
  components: { VizEventStart, VizFunction, VizSet },
  setup() {
    const greeterFunction: Ref<VizFunctionModel> = ref({ title: 'greeter', x: 360, y: 48 });
    const setFunction: Ref<VizSetModel> = ref({ x: 610, y: 48 });
    return { greeterFunction, setFunction };
  }
});
</script>
