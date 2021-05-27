<template lang="pug">
.viz-canvas
  template(v-for='vizNode in vizNodeMap')
    component(v-if='vizNode', :is='`viz-${vizNode.value.type}`', v-model='vizNode.value')
  template(v-for='vizConnection in vizConnections')
    component(v-if='vizConnection', :is='`viz-${vizConnection.value.type}-connection`', v-model='vizConnection.value')
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
import type { VizSlotConnectionModel } from '@/shared/models/connections/VizSlotConnectionModel';
import { convertConnection, VizConnection } from '@/shared/viz-components/connections/VizConnection';
import { convertNode, VizNode } from '@/shared/viz-components/nodes/VizNode';
import * as store from '@/store';
import { defineComponent, onMounted, ref, Ref } from 'vue';
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
    const vizNodeMap: Record<string, Ref<VizNode>> = Object.fromEntries(
      Object.entries(store.vizNodeMap()).map(([id, node]) => [id, convertNode(node)])
    );
    const vizConnections: Ref<Array<Ref<VizConnection>>> = ref([]);
    onMounted(() => {
      vizConnections.value.push(
        ...store
          .findAllConnections()
          .map((connection) =>
            convertConnection(connection, [vizNodeMap[connection.startNodeId]!, vizNodeMap[connection.endNodeId]!])
          )
      );
      Object.entries(vizNodeMap).forEach(([nodeId, node]) => {
        const foundEventEmitter: boolean = vizConnections.value
          .filter((connection) => connection.value.type === 'event')
          .some((connection) => connection.value.model?.startNodeId === nodeId);
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
          .some((connection) => connection.value.model?.endNodeId === nodeId);
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
          .filter((connection) => connection.value.model?.startNodeId === nodeId);
        for (const slotConnection of outputSlotConnections) {
          const slotConnectionModel: VizSlotConnectionModel | undefined = slotConnection.value.model as
            | VizSlotConnectionModel
            | undefined;
          if (!slotConnectionModel) {
            throw Error('slotConnectionModel not found');
          }
          const startNode: Ref<VizNode> | undefined = vizNodeMap[slotConnectionModel.startNodeId];
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
          .filter((connection) => connection.value.model?.endNodeId === nodeId);
        for (const slotConnection of inputSlotConnections) {
          const slotConnectionModel: VizSlotConnectionModel | undefined = slotConnection.value.model as
            | VizSlotConnectionModel
            | undefined;
          if (!slotConnectionModel) {
            throw Error('slotConnectionModel not found');
          }
          const endNode: Ref<VizNode> | undefined = vizNodeMap[slotConnectionModel.endNodeId];
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
                    node: vizNodeMap[slotConnectionModel.startNodeId]?.value,
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
    return { vizNodeMap, vizConnections };
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
