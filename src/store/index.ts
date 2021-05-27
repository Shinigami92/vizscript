import type { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import type { VizNodeModel } from '@/shared/models/nodes/VizNodeModel';
import { Ref, ref } from 'vue';

export interface RootState {
  currentViz: {
    eventStartNode: string;
    nodes: Record<string, VizNodeModel>;
    connections: Record<string, VizConnectionModel>;
  };
}

const state: Ref<RootState> = ref<RootState>({
  currentViz: {
    eventStartNode: '1',
    nodes: {
      1: { id: '1', type: 'event-start', x: 10, y: 48 },
      2: { id: '2', type: 'variable-get', name: 'user', x: 30, y: 192, dataType: 'string' },
      3: {
        id: '3',
        type: 'function',
        title: 'greeter',
        x: 360,
        y: 64,
        parameters: [{ name: 'person', type: 'string' }],
        return: { type: 'string' }
      },
      4: { id: '4', type: 'set', x: 610, y: 48 },
      9: { id: '9', type: 'variable-get', name: 'textContent', x: 360, y: 260, dataType: 'string' },
      11: {
        id: '11',
        type: 'caller-function',
        title: 'log',
        x: 870,
        y: 60,
        caller: { type: { name: 'Console' } },
        parameters: [{ name: 'msg', type: 'any', required: false }],
        return: { type: 'void' }
      },
      12: { id: '12', type: 'build-in-get', name: 'console', x: 670, y: 290, dataType: { name: 'Console' } }
    },
    connections: {
      5: { id: '5', type: 'event', startNodeId: '1', endNodeId: '3' },
      6: { id: '6', type: 'slot', startNodeId: '2', startSlot: 1, endNodeId: '3', endSlot: 1 },
      7: { id: '7', type: 'event', startNodeId: '3', endNodeId: '4' },
      8: { id: '8', type: 'slot', startNodeId: '3', startSlot: 1, endNodeId: '4', endSlot: 1 },
      10: { id: '10', type: 'slot', startNodeId: '9', startSlot: 1, endNodeId: '4', endSlot: 2 },
      13: { id: '13', type: 'slot', startNodeId: '12', startSlot: 1, endNodeId: '11', endSlot: 1 },
      14: { id: '14', type: 'event', startNodeId: '4', endNodeId: '11' },
      15: { id: '15', type: 'slot', startNodeId: '4', startSlot: 1, endNodeId: '11', endSlot: 2 }
    }
  }
});

export function findAllNodes(): VizNodeModel[] {
  return Object.values(state.value.currentViz.nodes);
}

export function vizNodeMap(): Record<string, VizNodeModel> {
  return state.value.currentViz.nodes;
}

export function findAllConnections(): VizConnectionModel[] {
  return Object.values(state.value.currentViz.connections);
}
