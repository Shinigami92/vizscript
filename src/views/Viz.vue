<script setup lang="ts">
import VizCurrentConnection from '@/components/viz-components/connections/VizCurrentConnection.vue';
import VizEventConnection from '@/components/viz-components/connections/VizEventConnection.vue';
import VizSlotConnection from '@/components/viz-components/connections/VizSlotConnection.vue';
import VizBuildInGet from '@/components/viz-components/nodes/VizBuildInGet.vue';
import VizCallerFunction from '@/components/viz-components/nodes/VizCallerFunction.vue';
import VizEventStart from '@/components/viz-components/nodes/VizEventStart.vue';
import VizFunction from '@/components/viz-components/nodes/VizFunction.vue';
import VizSet from '@/components/viz-components/nodes/VizSet.vue';
import VizVariableGet from '@/components/viz-components/nodes/VizVariableGet.vue';
import type { Point } from '@/shared/models/Point';
import type { PositionModel } from '@/shared/models/PositionModel';
import type { VizConnection } from '@/shared/viz-components/connections/VizConnection';
import { convertConnection } from '@/shared/viz-components/connections/VizConnection';
import type { VizNode } from '@/shared/viz-components/nodes/VizNode';
import { convertNode } from '@/shared/viz-components/nodes/VizNode';
import * as store from '@/store';
import { useElementByPoint, useMouse, usePointer } from '@vueuse/core';
import type { Ref } from 'vue';
import { computed, onMounted, ref, watch } from 'vue';

const clientOffset = ref<Point>({ x: 0, y: 0 });

const pointerPosition = useMouse({ type: 'client' });
const { element } = useElementByPoint(pointerPosition);

const relativePointerPosition = computed(() => ({
  x: ref(pointerPosition.x.value - clientOffset.value.x),
  y: ref(pointerPosition.y.value - clientOffset.value.y),
}));

store.initializeMock();

const vizNodeMap = Object.fromEntries(
  Object.entries(store.vizNodeMap()).map(([id, node]) => [
    id,
    convertNode(node),
  ]),
);

const vizConnections = ref<Array<Ref<VizConnection>>>([]);
const latestVizConnectionId = ref<string>();
const currentConnection = store.currentConnection;

const canvasRef = ref<HTMLDivElement | null>(null);

const {
  x: pointerPositionX,
  y: pointerPositionY,
  pressure,
} = usePointer({ target: canvasRef });

const lastPointerPosition = ref<PositionModel>({ x: 0, y: 0 });
watch([pointerPositionX, pointerPositionY], () => {
  if (pressure.value >= 0.5 && element.value === canvasRef.value) {
    const dx = pointerPositionX.value - lastPointerPosition.value.x;
    const dy = pointerPositionY.value - lastPointerPosition.value.y;

    store.moveAllNodes({ dx, dy });
    Object.entries(vizNodeMap).forEach(([id, node]) => {
      node.value.x += dx;
      node.value.y += dy;
    });
  }

  lastPointerPosition.value = {
    x: pointerPositionX.value,
    y: pointerPositionY.value,
  };
});

function nodeComponent(
  node: VizNode,
):
  | typeof VizBuildInGet
  | typeof VizCallerFunction
  | typeof VizEventStart
  | typeof VizFunction
  | typeof VizSet
  | typeof VizVariableGet {
  switch (node.type) {
    case 'build-in-get':
      return VizBuildInGet;
    case 'caller-function':
      return VizCallerFunction;
    case 'event-start':
      return VizEventStart;
    case 'function':
      return VizFunction;
    case 'set':
      return VizSet;
    case 'variable-get':
      return VizVariableGet;
  }
}

function connectionComponent(
  connection: VizConnection,
): typeof VizEventConnection | typeof VizSlotConnection {
  switch (connection.type) {
    case 'event':
      return VizEventConnection;
    case 'slot':
      return VizSlotConnection;
  }
}

watch(
  latestVizConnectionId,
  (id) => {
    if (!id) {
      return;
    }
    const connection = store.findConnectionById(id);
    if (!connection) {
      return;
    }
    const startVizNode = vizNodeMap[connection.startNodeId];
    if (!startVizNode) {
      return;
    }
    const endVizNode = vizNodeMap[connection.endNodeId];
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
          endVizNode.value.inputSlots[connection.endSlot - 1]!.connected = true;
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

onMounted(() => {
  store
    .findAllConnections()
    .forEach((connection) => (latestVizConnectionId.value = connection.id));

  const { x: xOffset, y: yOffset } = canvasRef.value
    ?.getClientRects()
    .item(0) ?? { x: 0, y: 0 };
  clientOffset.value = { x: xOffset, y: yOffset };
});
</script>

<template lang="pug">
.viz-canvas(ref="canvasRef")
  template(v-for="vizNode in vizNodeMap")
    component(
      :is="nodeComponent(vizNode.value)",
      v-if="vizNode",
      :key="vizNode.value.model?.id",
      v-model="vizNode.value"
    )
  template(v-for="vizConnection in vizConnections")
    component(
      :is="connectionComponent(vizConnection.value)",
      v-if="vizConnection",
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
