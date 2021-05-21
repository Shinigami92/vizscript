<template lang="pug">
.relative.overflow-hidden.h-full
  .text-3xl.text-primary-400 Viz
  viz-event-start(v-model='startEvent')
  viz-function(v-model='greeterFunction')
  viz-set(v-model='setFunction')
  viz-event-connection(v-model='eventConnection1')
</template>

<script lang="ts">
import VizEventConnection from '@/components/viz-components/connections/VizEventConnection.vue';
import VizEventStart from '@/components/viz-components/VizEventStart.vue';
import VizFunction from '@/components/viz-components/VizFunction.vue';
import VizSet from '@/components/viz-components/VizSet.vue';
import type { VizEventConnectionModel } from '@/shared/VizEventConnectionModel';
import type { VizEventStartModel } from '@/shared/VizEventStartModel';
import type { VizFunctionModel } from '@/shared/VizFunctionModel';
import type { VizSetModel } from '@/shared/VizSetModel';
import { defineComponent, Ref, ref } from 'vue';
export default defineComponent({
  components: { VizEventStart, VizFunction, VizSet, VizEventConnection },
  setup() {
    const startEvent: Ref<VizEventStartModel> = ref({ x: 10, y: 48 });
    const greeterFunction: Ref<VizFunctionModel> = ref({ title: 'greeter', x: 360, y: 64 });
    const setFunction: Ref<VizSetModel> = ref({ x: 610, y: 48 });
    const eventConnection1: Ref<VizEventConnectionModel> = ref({
      start: { x: startEvent.value.x + 192, y: startEvent.value.y + 82 },
      end: { x: greeterFunction.value.x, y: greeterFunction.value.y + 82 }
    });
    return { startEvent, greeterFunction, setFunction, eventConnection1 };
  }
});
</script>
