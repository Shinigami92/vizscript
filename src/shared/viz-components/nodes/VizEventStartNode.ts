import { VizEventStartNodeModel } from '@/shared/models/nodes/VizEventStartNodeModel';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizEventStartNode extends AbstractVizNode<'event-start'> {}

export function convertEventStartNode(model: VizEventStartNodeModel): Ref<VizEventStartNode> {
  return ref({ model, ...model });
}

export function isEventStartNode(modelValue: unknown): modelValue is VizEventStartNode {
  return isPositionable(modelValue);
}
