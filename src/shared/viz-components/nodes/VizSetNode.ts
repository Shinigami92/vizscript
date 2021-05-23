import { VizSetNodeModel } from '@/shared/models/nodes/VizSetNodeModel';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizSetNode extends AbstractVizNode<'set'> {
  eventReceiverConnected: boolean;
  eventEmitterConnected: boolean;
}

export function convertSetNode(model: VizSetNodeModel): Ref<VizSetNode> {
  return ref<VizSetNode>({ model, ...model, eventReceiverConnected: false, eventEmitterConnected: false });
}

export function isSetNode(modelValue: unknown): modelValue is VizSetNode {
  return isPositionable(modelValue);
}
