import { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import { Ref } from 'vue';
import { VizNode } from '../nodes/VizNode';
import { convertEventConnection, VizEventConnection } from './VizEventConnection';
import { convertSlotConnection, VizSlotConnection } from './VizSlotConnection';

export type VizConnection = VizEventConnection | VizSlotConnection;

export function convertConnection(model: VizConnectionModel, nodes: Array<Ref<VizNode>>): Ref<VizConnection> {
  switch (model.type) {
    case 'event':
      return convertEventConnection(model, nodes);
    case 'slot':
      return convertSlotConnection(model, nodes);
  }
  throw Error('Unsupported');
}
