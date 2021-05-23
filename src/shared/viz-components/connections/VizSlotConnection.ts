import { VizSlotConnectionModel } from '@/shared/models/connections/VizSlotConnectionModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable, Positionable } from '@/shared/viz-components/Positionable';
import { computed, ref, Ref } from 'vue';
import { VizNode } from '../nodes/VizNode';
import { AbstractVizConnection } from './AbstractVizConnection';

export interface VizSlotConnection extends AbstractVizConnection<'slot'> {}

export function convertSlotConnection(
  model: VizSlotConnectionModel,
  nodes: Array<Ref<VizNode>>
): Ref<VizSlotConnection> {
  const startNode: Ref<VizNode> | undefined = nodes.find((node) => node.value.model?.id === model.startNodeId);
  const endNode: Ref<VizNode> | undefined = nodes.find((node) => node.value.model?.id === model.endNodeId);
  return ref({
    model,
    ...model,
    start: computed(() => calculateOutputSlotPosition(startNode!.value)),
    end: computed(() => calculateInputSlotPosition(endNode!.value))
  });
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

export function calculateOutputSlotPosition(vizNode: VizNode): Positionable {
  switch (vizNode.type) {
    case 'variable-get':
      return { x: vizNode.x + 103, y: vizNode.y + 14 };
    case 'function':
      return { x: vizNode.x + 163, y: vizNode.y + 134 };
    default:
      throw Error(`[calculateOutputSlotPosition] Unsupported node type ${vizNode.type}`);
  }
}

export function calculateInputSlotPosition(vizNode: VizNode): Positionable {
  switch (vizNode.type) {
    case 'function':
      return { x: vizNode.x + 17, y: vizNode.y + 134 };
    case 'set':
      return { x: vizNode.x + 17, y: vizNode.y + 134 };
    default:
      throw Error(`[calculateInputSlotPosition] Unsupported node type ${vizNode.type}`);
  }
}
