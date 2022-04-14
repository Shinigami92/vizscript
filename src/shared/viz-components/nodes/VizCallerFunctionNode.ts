import type { VizCallerFunctionNodeModel } from '@/shared/models/nodes/VizCallerFunctionNodeModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable } from '@/shared/viz-components/Positionable';
import type { Ref } from 'vue';
import { ref } from 'vue';
import type { VizInputSlot } from '../slots/VizInputSlot';
import type { VizOutputSlot } from '../slots/VizOutputSlot';
import type { AbstractVizNode } from './AbstractVizNode';

export interface VizCallerFunctionNode
  extends AbstractVizNode<'caller-function'> {
  title: string;
  eventReceiverConnected: boolean;
  eventEmitterConnected: boolean;
  callerSlot: VizInputSlot;
  inputSlots: VizInputSlot[];
  returnSlot: VizOutputSlot;
}

export function convertCallerFunctionNode(
  model: VizCallerFunctionNodeModel,
): Ref<VizCallerFunctionNode> {
  return ref<VizCallerFunctionNode>({
    model,
    ...model,
    eventReceiverConnected: false,
    eventEmitterConnected: false,
    callerSlot: { name: 'caller', connected: false },
    inputSlots: model.parameters.map((parameter) => ({
      name: parameter.name,
      connected: false,
    })),
    returnSlot: { name: 'return', connected: false },
  });
}

export function isCallerFunctionNode(
  modelValue: unknown,
): modelValue is VizCallerFunctionNode {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (typeof modelValue.title !== 'string') {
    return false;
  }
  if (typeof modelValue.callerSlot !== 'object') {
    return false;
  }
  if (!isPositionable(modelValue)) {
    return false;
  }
  return true;
}
