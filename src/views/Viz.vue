<template lang="pug">
.relative.overflow-hidden.h-full
  //- TODO: Try `component(:is)`
  //- https://v3.vuejs.org/guide/component-basics.html#dynamic-components
  template(v-for='vizNode in vizNodes')
    viz-event-start(v-if='vizNode.value.type === "event-start"', v-model='vizNode.value')
    viz-variable-get(v-else-if='vizNode.value.type === "variable-get"', v-model='vizNode.value')
    viz-function(v-else-if='vizNode.value.type === "function"', v-model='vizNode.value')
    viz-set(v-else-if='vizNode.value.type === "set"', v-model='vizNode.value')
  template(v-for='vizConnection in vizConnections')
    viz-event-connection(v-if='vizConnection.value.type === "event"', v-model='vizConnection.value')
    viz-slot-connection(v-else-if='vizConnection.value.type === "slot"', v-model='vizConnection.value')
</template>

<script lang="ts">
import VizEventConnection from '@/components/viz-components/connections/VizEventConnection.vue';
import VizSlotConnection from '@/components/viz-components/connections/VizSlotConnection.vue';
import VizEventStart from '@/components/viz-components/nodes/VizEventStart.vue';
import VizFunction from '@/components/viz-components/nodes/VizFunction.vue';
import VizSet from '@/components/viz-components/nodes/VizSet.vue';
import VizVariableGet from '@/components/viz-components/nodes/VizVariableGet.vue';
import { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import { VizNodeModel } from '@/shared/models/nodes/VizNodeModel';
import { convertConnection, VizConnection } from '@/shared/viz-components/connections/VizConnection';
import { convertNode, VizNode } from '@/shared/viz-components/nodes/VizNode';
import { defineComponent, Ref } from 'vue';
const DB_MOCK_NODES: VizNodeModel[] = [
  {
    id: '1',
    type: 'event-start',
    x: 10,
    y: 48
  },
  {
    id: '2',
    type: 'variable-get',
    name: 'user',
    x: 30,
    y: 192
  },
  {
    id: '3',
    type: 'function',
    title: 'greeter',
    x: 360,
    y: 64,
    parameters: [{ name: 'person', type: 'string' }],
    return: { type: 'string' }
  },
  {
    id: '4',
    type: 'set',
    x: 610,
    y: 48
  }
];
const DB_MOCK_CONNECTIONS: VizConnectionModel[] = [
  {
    id: '5',
    type: 'event',
    startNodeId: '1',
    endNodeId: '3'
  },
  {
    id: '6',
    type: 'slot',
    startNodeId: '2',
    startSlot: 1,
    endNodeId: '3',
    endSlot: 1
  },
  {
    id: '7',
    type: 'event',
    startNodeId: '3',
    endNodeId: '4'
  },
  {
    id: '8',
    type: 'slot',
    startNodeId: '3',
    startSlot: 1,
    endNodeId: '4',
    endSlot: 1
  }
];
export default defineComponent({
  components: { VizEventStart, VizVariableGet, VizFunction, VizSet, VizEventConnection, VizSlotConnection },
  setup() {
    const vizNodes: Array<Ref<VizNode>> = DB_MOCK_NODES.map(convertNode);
    const vizConnections: Array<Ref<VizConnection>> = DB_MOCK_CONNECTIONS.map((connection) =>
      convertConnection(connection, vizNodes)
    );
    vizNodes.forEach((node) => {
      const foundEmitter: boolean = vizConnections.some(
        (connection) => connection.value.model?.startNodeId === node.value.model?.id
      );
      if (foundEmitter) {
        switch (node.value.type) {
          case 'event-start':
            node.value.connected = true;
            break;
          case 'function':
            node.value.eventEmitterConnected = true;
            break;
          case 'set':
            node.value.eventEmitterConnected = true;
            break;
        }
      }
      const foundReveiver: boolean = vizConnections.some(
        (connection) => connection.value.model?.endNodeId === node.value.model?.id
      );
      if (foundReveiver) {
        switch (node.value.type) {
          case 'function':
            node.value.eventReceiverConnected = true;
            break;
          case 'set':
            node.value.eventReceiverConnected = true;
            break;
        }
      }
    });
    return { vizNodes, vizConnections };
  }
});
</script>
