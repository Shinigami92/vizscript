import { VizFunctionNodeModel } from '@/shared/models/nodes/VizFunctionNodeModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { VizInputSlot } from '../slots/VizInputSlot';
import { VizOutputSlot } from '../slots/VizOutputSlot';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizFunctionNode extends AbstractVizNode<'function'> {
  title: string;
  eventReceiverConnected: boolean;
  eventEmitterConnected: boolean;
  inputSlots: VizInputSlot[];
  returnSlot: VizOutputSlot;
}

export function convertFunctionNode(model: VizFunctionNodeModel): Ref<VizFunctionNode> {
  return ref<VizFunctionNode>({
    model,
    ...model,
    eventReceiverConnected: false,
    eventEmitterConnected: false,
    inputSlots: model.parameters.map((parameter) => ({
      name: parameter.name,
      connected: false
    })),
    returnSlot: { name: 'return', connected: false }
  });
}

export function isFunctionNode(modelValue: unknown): modelValue is VizFunctionNode {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (typeof modelValue.title !== 'string') {
    return false;
  }
  if (!isPositionable(modelValue)) {
    return false;
  }
  return true;
}
