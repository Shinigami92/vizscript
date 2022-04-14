<script lang="ts">
import VizCurrentConnection from '@/components/viz-components/connections/VizCurrentConnection.vue';
import VizEventConnection from '@/components/viz-components/connections/VizEventConnection.vue';
import VizSlotConnection from '@/components/viz-components/connections/VizSlotConnection.vue';
import VizBuildInGet from '@/components/viz-components/nodes/VizBuildInGet.vue';
import VizCallerFunction from '@/components/viz-components/nodes/VizCallerFunction.vue';
import VizEventStart from '@/components/viz-components/nodes/VizEventStart.vue';
import VizFunction from '@/components/viz-components/nodes/VizFunction.vue';
import VizSet from '@/components/viz-components/nodes/VizSet.vue';
import VizVariableGet from '@/components/viz-components/nodes/VizVariableGet.vue';
import type { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import type { VizCurrentConnectionModel } from '@/shared/models/connections/VizCurrentConnectionModel';
import type { RefPositionModel } from '@/shared/models/PositionModel';
import type { VizConnection } from '@/shared/viz-components/connections/VizConnection';
import { convertConnection } from '@/shared/viz-components/connections/VizConnection';
import type { VizNode } from '@/shared/viz-components/nodes/VizNode';
import { convertNode } from '@/shared/viz-components/nodes/VizNode';
import * as store from '@/store';
import { useMouse } from '@vueuse/core';
import type { ComputedRef, Ref } from 'vue';
import { computed, defineComponent, onMounted, ref, watch } from 'vue';

export default defineComponent({
  components: {
    VizEventStart,
    VizCallerFunction,
    VizFunction,
    VizSet,
    VizBuildInGet,
    VizVariableGet,
    VizEventConnection,
    VizSlotConnection,
    VizCurrentConnection,
  },
  setup() {
    const pointerPosition: RefPositionModel = useMouse();

    const relativePointerPosition: ComputedRef<RefPositionModel> =
      computed<RefPositionModel>(() => ({
        x: ref(pointerPosition.x.value - 320),
        y: ref(pointerPosition.y.value - 56),
      }));

    store.initializeMock();

    const vizNodeMap: Record<string, Ref<VizNode>> = Object.fromEntries(
      Object.entries(store.vizNodeMap()).map(([id, node]) => [
        id,
        convertNode(node),
      ]),
    );

    const vizConnections: Ref<Array<Ref<VizConnection>>> = ref([]);
    const latestVizConnectionId: Ref<string | undefined> = ref();
    const currentConnection: ComputedRef<VizCurrentConnectionModel | null> =
      store.currentConnection;

    watch(
      latestVizConnectionId,
      (id) => {
        if (!id) {
          return;
        }
        const connection: VizConnectionModel | undefined =
          store.findConnectionById(id);
        if (!connection) {
          return;
        }
        const startVizNode: Ref<VizNode> | undefined =
          vizNodeMap[connection.startNodeId];
        if (!startVizNode) {
          return;
        }
        const endVizNode: Ref<VizNode> | undefined =
          vizNodeMap[connection.endNodeId];
        if (!endVizNode) {
          return;
        }

        vizConnections.value.push(
          convertConnection(connection, [startVizNode, endVizNode]),
        );

        if (connection.type === 'event') {
          switch (startVizNode.value.type) {
            case 'event-start':
              startVizNode.value.connected = true;
              break;
            case 'function':
              startVizNode.value.eventEmitterConnected = true;
              break;
            case 'set':
              startVizNode.value.eventEmitterConnected = true;
              break;
            default:
              throw Error(
                `[foundEventEmitter] connection not set for ${startVizNode.value.type}`,
              );
          }

          switch (endVizNode.value.type) {
            case 'caller-function':
              endVizNode.value.eventReceiverConnected = true;
              break;
            case 'function':
              endVizNode.value.eventReceiverConnected = true;
              break;
            case 'set':
              endVizNode.value.eventReceiverConnected = true;
              break;
            default:
              throw Error(
                `[foundEventReceiver] connection not set for ${endVizNode.value.type}`,
              );
          }
        } else if (connection.type === 'slot') {
          switch (startVizNode.value.type) {
            case 'function':
              startVizNode.value.returnSlot.connected = true;
              break;
            case 'set':
              startVizNode.value.resultSlot.connected = true;
              break;
            case 'build-in-get':
              startVizNode.value.outputSlot.connected = true;
              break;
            case 'variable-get':
              startVizNode.value.outputSlot.connected = true;
              break;
            default:
              throw Error(
                `[outputSlotConnection] connection not set for ${startVizNode.value.type}`,
              );
          }

          switch (endVizNode.value.type) {
            case 'caller-function':
              if (connection.endSlot === 1) {
                endVizNode.value.callerSlot.connected = true;
              } else {
                endVizNode.value.inputSlots[connection.endSlot - 2]!.connected =
                  true;
              }
              break;
            case 'function':
              endVizNode.value.inputSlots[connection.endSlot - 1]!.connected =
                true;
              break;
            case 'set':
              if (connection.endSlot === 1) {
                endVizNode.value.valueSlot.connected = true;
              } else if (connection.endSlot === 2) {
                endVizNode.value.targetSlot.connected = true;
                endVizNode.value.targetSlot.connectedToNode = {
                  node: startVizNode.value,
                  slot: connection.startSlot,
                };
              }
              break;
            default:
              throw Error(
                `[inputSlotConnection] connection not set for ${endVizNode.value.type}`,
              );
          }
        }
      },
      {
        flush: 'sync',
      },
    );

    onMounted(() =>
      store
        .findAllConnections()
        .forEach((connection) =>
          setTimeout(
            () => (latestVizConnectionId.value = connection.id),
            Math.random() * 2000,
          ),
        ),
    );

    return {
      vizNodeMap,
      vizConnections,
      currentConnection,
      relativePointerPosition,
    };
  },
});
</script>

<template lang="pug">
.viz-canvas
  template(v-for="vizNode in vizNodeMap")
    component(
      v-if="vizNode",
      :is="`viz-${vizNode.value.type}`",
      :key="vizNode.value.model?.id",
      v-model="vizNode.value"
    )
  template(v-for="vizConnection in vizConnections")
    component(
      v-if="vizConnection",
      :is="`viz-${vizConnection.value.type}-connection`",
      :key="vizConnection.value.model?.id",
      v-model="vizConnection.value"
    )
  VizCurrentConnection(
    v-if="currentConnection",
    :current-connection="currentConnection",
    :pointer-position="relativePointerPosition"
  )
</template>

<style lang="postcss" scoped>
.viz-canvas {
  @apply relative overflow-hidden h-full;

  /* Grid https://stackoverflow.com/a/25709375/6897682 */
  background: linear-gradient(
      -90deg,
      rgba(255, 255, 255, 0.1) 1px,
      transparent 1px
    ),
    linear-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px),
    linear-gradient(-90deg, rgba(255, 255, 255, 0.2) 1px, transparent 1px),
    linear-gradient(rgba(255, 255, 255, 0.2) 1px, transparent 1px),
    linear-gradient(
      transparent 3px,
      transparent 3px,
      transparent 382px,
      transparent 382px
    ),
    linear-gradient(-90deg, rgba(255, 255, 255, 0.4) 1px, transparent 1px),
    linear-gradient(
      -90deg,
      transparent 3px,
      transparent 3px,
      transparent 382px,
      transparent 382px
    ),
    linear-gradient(rgba(255, 255, 255, 0.4) 1px, transparent 1px), transparent;
  background-size: 48px 48px, 48px 48px, 384px 384px, 384px 384px, 384px 384px,
    384px 384px, 384px 384px, 384px 384px;
}
</style>
