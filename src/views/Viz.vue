<template lang="pug">
.relative.overflow-hidden.h-full
  .text-3xl.text-primary-400 Viz
  //- TODO: Try `component(:is)`
  //- https://v3.vuejs.org/guide/component-basics.html#dynamic-components
  template(v-for='vizComponent in vizComponents')
    viz-event-start(v-if='vizComponent.value.type === "event-start"', v-model='vizComponent.value')
    viz-function(v-else-if='vizComponent.value.type === "function"', v-model='vizComponent.value')
    viz-set(v-else-if='vizComponent.value.type === "set"', v-model='vizComponent.value')
  viz-event-connection(v-model='eventConnection1')
</template>

<script lang="ts">
import VizEventConnection from '@/components/viz-components/connections/VizEventConnection.vue';
import VizEventStart from '@/components/viz-components/VizEventStart.vue';
import VizFunction from '@/components/viz-components/VizFunction.vue';
import VizSet from '@/components/viz-components/VizSet.vue';
import {
  calculateInputEventReceiverPosition,
  calculateOutputEventEmitterPosition,
  VizComponentModel
} from '@/shared/VizComponentModel';
import type { VizEventConnectionModel } from '@/shared/VizEventConnectionModel';
import { defineComponent, Ref, ref } from 'vue';
export default defineComponent({
  components: { VizEventStart, VizFunction, VizSet, VizEventConnection },
  setup() {
    const vizComponents: Array<Ref<VizComponentModel>> = [
      ref<VizComponentModel>({ type: 'event-start', x: 10, y: 48 }),
      ref<VizComponentModel>({ type: 'function', title: 'greeter', x: 360, y: 64 }),
      ref<VizComponentModel>({ type: 'set', x: 610, y: 48 })
    ];
    const eventConnection1: Ref<VizEventConnectionModel> = ref({
      start: calculateOutputEventEmitterPosition(vizComponents[0]!.value),
      end: calculateInputEventReceiverPosition(vizComponents[1]!.value)
    });
    return { vizComponents, eventConnection1 };
  }
});
</script>
