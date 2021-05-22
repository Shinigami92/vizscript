import { VizSlotConnectionModel } from '@/shared/models/connections/VizSlotConnectionModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { Ref } from 'vue';
import { VizNode } from '../nodes/VizNode';
import { AbstractVizConnection } from './AbstractVizConnection';

export interface VizSlotConnection extends AbstractVizConnection<'slot'> {}

export function convertSlotConnection(
  model: VizSlotConnectionModel,
  nodes: Array<Ref<VizNode>>
): Ref<VizSlotConnection> {
  throw Error('Unsupported');
}

export function isSlotConnection(modelValue: unknown): modelValue is VizSlotConnection {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (!isPositionable(modelValue.start)) {
    return false;
  }
  if (!isPositionable(modelValue.end)) {
    return false;
  }
  return true;
}
