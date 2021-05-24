<template lang="pug">
.viz-canvas
  //- TODO: Try `component(:is)`
  //- https://v3.vuejs.org/guide/component-basics.html#dynamic-components
  template(v-for='vizNode in vizNodes')
    viz-event-start(v-if='vizNode.value.type === "event-start"', v-model='vizNode.value')
    viz-caller-function(v-else-if='vizNode.value.type === "caller-function"', v-model='vizNode.value')
    viz-function(v-else-if='vizNode.value.type === "function"', v-model='vizNode.value')
    viz-set(v-else-if='vizNode.value.type === "set"', v-model='vizNode.value')
    viz-build-in-get(v-else-if='vizNode.value.type === "build-in-get"', v-model='vizNode.value')
    viz-variable-get(v-else-if='vizNode.value.type === "variable-get"', v-model='vizNode.value')
  template(v-for='vizConnection in vizConnections')
    viz-event-connection(v-if='vizConnection.value.type === "event"', v-model='vizConnection.value')
    viz-slot-connection(v-else-if='vizConnection.value.type === "slot"', v-model='vizConnection.value')
</template>

<script lang="ts">
import VizEventConnection from '@/components/viz-components/connections/VizEventConnection.vue';
import VizSlotConnection from '@/components/viz-components/connections/VizSlotConnection.vue';
import VizBuildInGet from '@/components/viz-components/nodes/VizBuildInGet.vue';
import VizCallerFunction from '@/components/viz-components/nodes/VizCallerFunction.vue';
import VizEventStart from '@/components/viz-components/nodes/VizEventStart.vue';
import VizFunction from '@/components/viz-components/nodes/VizFunction.vue';
import VizSet from '@/components/viz-components/nodes/VizSet.vue';
import VizVariableGet from '@/components/viz-components/nodes/VizVariableGet.vue';
import { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import { VizSlotConnectionModel } from '@/shared/models/connections/VizSlotConnectionModel';
import { VizNodeModel } from '@/shared/models/nodes/VizNodeModel';
import { convertConnection, VizConnection } from '@/shared/viz-components/connections/VizConnection';
import { convertNode, VizNode } from '@/shared/viz-components/nodes/VizNode';
import { defineComponent, onMounted, ref, Ref } from 'vue';
const DB_MOCK_NODES: VizNodeModel[] = [
  { id: '1', type: 'event-start', x: 10, y: 48 },
  { id: '2', type: 'variable-get', name: 'user', x: 30, y: 192, dataType: 'string' },
  {
    id: '3',
    type: 'function',
    title: 'greeter',
    x: 360,
    y: 64,
    parameters: [{ name: 'person', type: 'string' }],
    return: { type: 'string' }
  },
  { id: '4', type: 'set', x: 610, y: 48 },
  { id: '9', type: 'variable-get', name: 'textContent', x: 360, y: 260, dataType: 'string' },
  {
    id: '11',
    type: 'caller-function',
    title: 'log',
    x: 870,
    y: 60,
    caller: { type: { name: 'Console' } },
    parameters: [{ name: 'msg', type: 'any', required: false }],
    return: { type: 'void' }
  },
  { id: '12', type: 'build-in-get', name: 'console', x: 670, y: 290, dataType: { name: 'Console' } }
];
const DB_MOCK_CONNECTIONS: VizConnectionModel[] = [
  { id: '5', type: 'event', startNodeId: '1', endNodeId: '3' },
  { id: '6', type: 'slot', startNodeId: '2', startSlot: 1, endNodeId: '3', endSlot: 1 },
  { id: '7', type: 'event', startNodeId: '3', endNodeId: '4' },
  { id: '8', type: 'slot', startNodeId: '3', startSlot: 1, endNodeId: '4', endSlot: 1 },
  { id: '10', type: 'slot', startNodeId: '9', startSlot: 1, endNodeId: '4', endSlot: 2 },
  { id: '13', type: 'slot', startNodeId: '12', startSlot: 1, endNodeId: '11', endSlot: 1 },
  { id: '14', type: 'event', startNodeId: '4', endNodeId: '11' },
  { id: '15', type: 'slot', startNodeId: '4', startSlot: 1, endNodeId: '11', endSlot: 2 }
];
export default defineComponent({
  components: {
    VizEventStart,
    VizCallerFunction,
    VizFunction,
    VizSet,
    VizBuildInGet,
    VizVariableGet,
    VizEventConnection,
    VizSlotConnection
  },
  setup() {
    const vizNodes: Array<Ref<VizNode>> = DB_MOCK_NODES.map(convertNode);
    const vizConnections: Ref<Array<Ref<VizConnection>>> = ref([]);
    onMounted(() => {
      vizConnections.value.push(...DB_MOCK_CONNECTIONS.map((connection) => convertConnection(connection, vizNodes)));
      vizNodes.forEach((node) => {
        const foundEventEmitter: boolean = vizConnections.value
          .filter((connection) => connection.value.type === 'event')
          .some((connection) => connection.value.model?.startNodeId === node.value.model?.id);
        if (foundEventEmitter) {
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
            default:
              throw Error(`[foundEventEmitter] connection not set for ${node.value.type}`);
          }
        }
        const foundEventReveiver: boolean = vizConnections.value
          .filter((connection) => connection.value.type === 'event')
          .some((connection) => connection.value.model?.endNodeId === node.value.model?.id);
        if (foundEventReveiver) {
          switch (node.value.type) {
            case 'caller-function':
              node.value.eventReceiverConnected = true;
              break;
            case 'function':
              node.value.eventReceiverConnected = true;
              break;
            case 'set':
              node.value.eventReceiverConnected = true;
              break;
            default:
              throw Error(`[foundEventReveiver] connection not set for ${node.value.type}`);
          }
        }
        const outputSlotConnections: Array<Ref<VizConnection>> = vizConnections.value
          .filter((connection) => connection.value.type === 'slot')
          .filter((connection) => connection.value.model?.startNodeId === node.value.model?.id);
        for (const slotConnection of outputSlotConnections) {
          const slotConnectionModel: VizSlotConnectionModel | undefined = slotConnection.value.model as
            | VizSlotConnectionModel
            | undefined;
          if (!slotConnectionModel) {
            throw Error('slotConnectionModel not found');
          }
          const startNode: Ref<VizNode> | undefined = vizNodes.find(
            (vizNode) => slotConnectionModel.startNodeId === vizNode.value.model?.id
          );
          if (startNode) {
            switch (startNode.value.type) {
              case 'function':
                startNode.value.returnSlot.connected = true;
                break;
              case 'set':
                startNode.value.resultSlot.connected = true;
                break;
              case 'build-in-get':
                startNode.value.outputSlot.connected = true;
                break;
              case 'variable-get':
                startNode.value.outputSlot.connected = true;
                break;
              default:
                throw Error(`[outputSlotConnection] connection not set for ${startNode.value.type}`);
            }
          }
        }
        const inputSlotConnections: Array<Ref<VizConnection>> = vizConnections.value
          .filter((connection) => connection.value.type === 'slot')
          .filter((connection) => connection.value.model?.endNodeId === node.value.model?.id);
        for (const slotConnection of inputSlotConnections) {
          const slotConnectionModel: VizSlotConnectionModel | undefined = slotConnection.value.model as
            | VizSlotConnectionModel
            | undefined;
          if (!slotConnectionModel) {
            throw Error('slotConnectionModel not found');
          }
          const endNode: Ref<VizNode> | undefined = vizNodes.find(
            (vizNode) => slotConnectionModel.endNodeId === vizNode.value.model?.id
          );
          if (endNode) {
            switch (endNode.value.type) {
              case 'caller-function':
                if (slotConnectionModel.endSlot === 1) {
                  endNode.value.callerSlot.connected = true;
                } else {
                  endNode.value.inputSlots[slotConnectionModel.endSlot - 2]!.connected = true;
                }
                break;
              case 'function':
                endNode.value.inputSlots[slotConnectionModel.endSlot - 1]!.connected = true;
                break;
              case 'set':
                if (slotConnectionModel.endSlot === 1) {
                  endNode.value.valueSlot.connected = true;
                } else if (slotConnectionModel.endSlot === 2) {
                  endNode.value.targetSlot.connected = true;
                  endNode.value.targetSlot.connectedToNode = {
                    node: vizNodes.find((vizNode) => slotConnectionModel.startNodeId === vizNode.value.model?.id)
                      ?.value,
                    slot: slotConnectionModel.startSlot
                  };
                }
                break;
              default:
                throw Error(`[inputSlotConnection] connection not set for ${endNode.value.type}`);
            }
          }
        }
      });
    });
    return { vizNodes, vizConnections };
  }
});
</script>

<style lang="postcss" scoped>
.viz-canvas {
  @apply relative overflow-hidden h-full;

  /* Grid https://stackoverflow.com/a/25709375/6897682 */
  background: linear-gradient(-90deg, rgba(255, 255, 255, 0.1) 1px, transparent 1px),
    linear-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px),
    linear-gradient(-90deg, rgba(255, 255, 255, 0.2) 1px, transparent 1px),
    linear-gradient(rgba(255, 255, 255, 0.2) 1px, transparent 1px),
    linear-gradient(transparent 3px, transparent 3px, transparent 382px, transparent 382px),
    linear-gradient(-90deg, rgba(255, 255, 255, 0.4) 1px, transparent 1px),
    linear-gradient(-90deg, transparent 3px, transparent 3px, transparent 382px, transparent 382px),
    linear-gradient(rgba(255, 255, 255, 0.4) 1px, transparent 1px), transparent;
  background-size: 48px 48px, 48px 48px, 384px 384px, 384px 384px, 384px 384px, 384px 384px, 384px 384px, 384px 384px;
}
</style>
