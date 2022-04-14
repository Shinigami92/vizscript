import type { VizEventStartNodeModel } from '@/shared/models/nodes/VizEventStartNodeModel';
import { isPositionable } from '@/shared/viz-components/Positionable';
import type { Ref } from 'vue';
import { ref } from 'vue';
import type { AbstractVizNode } from './AbstractVizNode';

export interface VizEventStartNode extends AbstractVizNode<'event-start'> {
  connected: boolean;
}

export function convertEventStartNode(
  model: VizEventStartNodeModel,
): Ref<VizEventStartNode> {
  return ref<VizEventStartNode>({ model, ...model, connected: false });
}

export function isEventStartNode(
  modelValue: unknown,
): modelValue is VizEventStartNode {
  return isPositionable(modelValue);
}
