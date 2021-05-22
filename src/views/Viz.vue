<template lang="pug">
.relative.overflow-hidden.h-full
  //- TODO: Try `component(:is)`
  //- https://v3.vuejs.org/guide/component-basics.html#dynamic-components
  template(v-for='vizComponent in vizComponents')
    viz-event-start(v-if='vizComponent.value.type === "event-start"', v-model='vizComponent.value')
    viz-variable-get(v-else-if='vizComponent.value.type === "variable-get"', v-model='vizComponent.value')
    viz-function(v-else-if='vizComponent.value.type === "function"', v-model='vizComponent.value')
    viz-set(v-else-if='vizComponent.value.type === "set"', v-model='vizComponent.value')
  viz-event-connection(v-model='eventConnection1')
</template>

<script lang="ts">
import VizEventConnection from '@/components/viz-components/connections/VizEventConnection.vue';
import VizEventStart from '@/components/viz-components/VizEventStart.vue';
import VizFunction from '@/components/viz-components/VizFunction.vue';
import VizSet from '@/components/viz-components/VizSet.vue';
import VizVariableGet from '@/components/viz-components/VizVariableGet.vue';
import {
  calculateInputEventReceiverPosition,
  calculateOutputEventEmitterPosition,
  VizComponentModel
} from '@/shared/VizComponentModel';
import type { VizEventConnectionModel } from '@/shared/VizEventConnectionModel';
import { computed, defineComponent, Ref, ref } from 'vue';
export default defineComponent({
  components: { VizEventStart, VizVariableGet, VizFunction, VizSet, VizEventConnection },
  setup() {
    const vizComponents: Array<Ref<VizComponentModel>> = [
      ref<VizComponentModel>({ type: 'event-start', x: 10, y: 48 }),
      ref<VizComponentModel>({ type: 'variable-get', name: 'user', x: 30, y: 192 }),
      ref<VizComponentModel>({ type: 'function', title: 'greeter', x: 360, y: 64 }),
      ref<VizComponentModel>({ type: 'set', x: 610, y: 48 })
    ];
    const eventConnection1: Ref<VizEventConnectionModel> = ref({
      start: computed(() => calculateOutputEventEmitterPosition(vizComponents[0]!.value)),
      end: computed(() => calculateInputEventReceiverPosition(vizComponents[2]!.value))
    });
    return { vizComponents, eventConnection1 };
  }
});
</script>
