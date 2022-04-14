import type { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import type { Ref } from 'vue';
import type { VizNode } from '../nodes/VizNode';
import type { VizEventConnection } from './VizEventConnection';
import { convertEventConnection } from './VizEventConnection';
import type { VizSlotConnection } from './VizSlotConnection';
import { convertSlotConnection } from './VizSlotConnection';

export type VizConnection = VizEventConnection | VizSlotConnection;

export function convertConnection(
  model: VizConnectionModel,
  nodes: Array<Ref<VizNode>>,
): Ref<VizConnection> {
  switch (model.type) {
    case 'event':
      return convertEventConnection(model, nodes);
    case 'slot':
      return convertSlotConnection(model, nodes);
  }
  throw Error('Unsupported');
}
