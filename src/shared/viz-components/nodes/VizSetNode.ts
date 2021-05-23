import { VizSetNodeModel } from '@/shared/models/nodes/VizSetNodeModel';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { VizInputSlot } from '../slots/VizInputSlot';
import { VizOutputSlot } from '../slots/VizOutputSlot';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizSetNode extends AbstractVizNode<'set'> {
  eventReceiverConnected: boolean;
  eventEmitterConnected: boolean;
  valueSlot: VizInputSlot;
  targetSlot: VizInputSlot;
  resultSlot: VizOutputSlot;
}

export function convertSetNode(model: VizSetNodeModel): Ref<VizSetNode> {
  return ref<VizSetNode>({
    model,
    ...model,
    eventReceiverConnected: false,
    eventEmitterConnected: false,
    valueSlot: { name: 'value', connected: false },
    targetSlot: { name: 'target', connected: false },
    resultSlot: { name: 'result', connected: false }
  });
}

export function isSetNode(modelValue: unknown): modelValue is VizSetNode {
  return isPositionable(modelValue);
}
