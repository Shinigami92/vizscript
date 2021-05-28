import type { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import type { VizEventConnectionModel } from '@/shared/models/connections/VizEventConnectionModel';
import type { VizSlotConnectionModel } from '@/shared/models/connections/VizSlotConnectionModel';
import type { AbstractVizNodeModel } from '@/shared/models/nodes/AbstractVizNodeModel';
import type { VizBuildInGetNodeModel } from '@/shared/models/nodes/VizBuildInGetNode';
import type { VizCallerFunctionNodeModel } from '@/shared/models/nodes/VizCallerFunctionNodeModel';
import type { VizEventStartNodeModel } from '@/shared/models/nodes/VizEventStartNodeModel';
import type { VizFunctionNodeModel } from '@/shared/models/nodes/VizFunctionNodeModel';
import type { VizNodeModel, VizNodeType } from '@/shared/models/nodes/VizNodeModel';
import type { VizSetNodeModel } from '@/shared/models/nodes/VizSetNodeModel';
import type { VizVariableGetNodeModel } from '@/shared/models/nodes/VizVariableGetNodeModel';
import type { PositionModel } from '@/shared/models/PositionModel';
import { v4 as uuidv4 } from 'uuid';
import { Ref, ref } from 'vue';

export interface RootState {
  currentViz: {
    eventStartNode: string | null;
    nodes: Record<string, VizNodeModel>;
    connections: Record<string, VizConnectionModel>;
  };
}

const state: Ref<RootState> = ref<RootState>({
  currentViz: {
    eventStartNode: null,
    nodes: {},
    connections: {}
  }
});

export function findAllNodes(): VizNodeModel[] {
  return Object.values(state.value.currentViz.nodes);
}

export function updateNodePosition(id: string, { x, y }: PositionModel): void {
  const n: VizNodeModel | undefined = state.value.currentViz.nodes[id];
  if (!n) {
    return;
  }
  n.x = x;
  n.y = y;
}

export function vizNodeMap(): Record<string, VizNodeModel> {
  return state.value.currentViz.nodes;
}

export function findNodeById(id: string): VizNodeModel | undefined {
  return state.value.currentViz.nodes[id];
}

export function createNode<Type extends VizNodeType, Node extends AbstractVizNodeModel<Type>>(
  type: Type,
  node: Omit<Node, 'id' | 'type'>
): Node {
  const id: string = uuidv4();
  state.value.currentViz.nodes[id] = { ...node, type, id } as VizNodeModel;
  return state.value.currentViz.nodes[id] as Node;
}

export function findAllConnections(): VizConnectionModel[] {
  return Object.values(state.value.currentViz.connections);
}

export function createEventConnection({
  startNode,
  endNode
}: {
  startNode: VizNodeModel;
  endNode: VizNodeModel;
}): VizEventConnectionModel {
  const id: string = uuidv4();
  state.value.currentViz.connections[id] = {
    id,
    type: 'event',
    startNodeId: startNode.id,
    endNodeId: endNode.id
  };
  return state.value.currentViz.connections[id] as VizEventConnectionModel;
}

export function createSlotConnection({
  startNode,
  endNode,
  startSlot,
  endSlot
}: {
  startNode: VizNodeModel;
  endNode: VizNodeModel;
  startSlot: number;
  endSlot: number;
}): VizSlotConnectionModel {
  const id: string = uuidv4();
  state.value.currentViz.connections[id] = {
    id,
    type: 'slot',
    startNodeId: startNode.id,
    startSlot,
    endNodeId: endNode.id,
    endSlot
  };
  return state.value.currentViz.connections[id] as VizSlotConnectionModel;
}

export function findConnectionById(id: string): VizConnectionModel | undefined {
  return state.value.currentViz.connections[id];
}

// --- Mock Data ---
let mockInitialized: boolean = false;

export function initializeMock(): void {
  if (mockInitialized) {
    return;
  }
  mockInitialized = true;

  // Nodes
  const eventStart: VizEventStartNodeModel = createNode('event-start', { x: 10, y: 48 });

  state.value.currentViz.eventStartNode = eventStart.id;

  const user: VizVariableGetNodeModel = createNode('variable-get', { x: 30, y: 192, name: 'user', dataType: 'string' });
  const greeter: VizFunctionNodeModel = createNode('function', {
    x: 360,
    y: 64,
    title: 'greeter',
    parameters: [{ name: 'person', type: 'string' }],
    return: { type: 'string' }
  });
  const setTextContent: VizSetNodeModel = createNode('set', { x: 610, y: 48 });
  const textContent: VizVariableGetNodeModel = createNode('variable-get', {
    x: 360,
    y: 260,
    name: 'textContent',
    dataType: 'string'
  });
  const log: VizCallerFunctionNodeModel = createNode('caller-function', {
    x: 870,
    y: 60,
    title: 'log',
    caller: { type: { name: 'Console' } },
    parameters: [{ name: 'msg', type: 'any', required: false }],
    return: { type: 'void' }
  });
  const consoleNode: VizBuildInGetNodeModel = createNode('build-in-get', {
    x: 670,
    y: 290,
    name: 'console',
    dataType: { name: 'Console' }
  });

  // Connections
  createEventConnection({ startNode: eventStart, endNode: greeter });
  createSlotConnection({ startNode: user, startSlot: 1, endNode: greeter, endSlot: 1 });
  createEventConnection({ startNode: greeter, endNode: setTextContent });
  createSlotConnection({ startNode: greeter, startSlot: 1, endNode: setTextContent, endSlot: 1 });
  createSlotConnection({ startNode: textContent, startSlot: 1, endNode: setTextContent, endSlot: 2 });
  createSlotConnection({ startNode: consoleNode, startSlot: 1, endNode: log, endSlot: 1 });
  createEventConnection({ startNode: setTextContent, endNode: log });
  createSlotConnection({ startNode: setTextContent, startSlot: 1, endNode: log, endSlot: 2 });
}
