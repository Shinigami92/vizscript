import { VizEventConnectionModel } from '@/shared/models/connections/VizEventConnectionModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable, Positionable } from '@/shared/viz-components/Positionable';
import { computed, ref, Ref } from 'vue';
import { VizNode } from '../nodes/VizNode';
import { AbstractVizConnection } from './AbstractVizConnection';

export interface VizEventConnection extends AbstractVizConnection<'event'> {}

export function convertEventConnection(
  model: VizEventConnectionModel,
  nodes: Array<Ref<VizNode>>
): Ref<VizEventConnection> {
  const startNode: Ref<VizNode> | undefined = nodes.find((node) => node.value.model?.id === model.startNodeId);
  const endNode: Ref<VizNode> | undefined = nodes.find((node) => node.value.model?.id === model.endNodeId);
  return ref({
    model,
    ...model,
    start: computed(() => calculateOutputEventEmitterPosition(startNode!.value)),
    end: computed(() => calculateInputEventReceiverPosition(endNode!.value))
  });
}

export function isEventConnection(modelValue: unknown): modelValue is VizEventConnection {
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

export function calculateInputEventReceiverPosition(vizNode: VizNode): Positionable {
  switch (vizNode.type) {
    case 'function':
      return { x: vizNode.x + 14, y: vizNode.y + 82 };
    case 'set':
      return { x: vizNode.x + 14, y: vizNode.y + 82 };
    default:
      throw Error(`[calculateInputEventReceiverPosition] Unsupported node type ${vizNode.type}`);
  }
}

export function calculateOutputEventEmitterPosition(vizNode: VizNode): Positionable {
  switch (vizNode.type) {
    case 'event-start':
      return { x: vizNode.x + 174, y: vizNode.y + 82 };
    case 'function':
      return { x: vizNode.x + 160, y: vizNode.y + 82 };
    default:
      throw Error(`[calculateOutputEventEmitterPosition] Unsupported node type ${vizNode.type}`);
  }
}
