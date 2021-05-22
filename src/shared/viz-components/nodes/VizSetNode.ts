import { VizSetNodeModel } from '@/shared/models/nodes/VizSetNodeModel';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizSetNode extends AbstractVizNode<'set'> {}

export function convertSetNode(model: VizSetNodeModel): Ref<VizSetNode> {
  return ref({ model, ...model });
}

export function isSetNode(modelValue: unknown): modelValue is VizSetNode {
  return isPositionable(modelValue);
}
