import { VizFunctionNodeModel } from '@/shared/models/nodes/VizFunctionNodeModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizFunctionNode extends AbstractVizNode<'function'> {
  title: string;
}

export function convertFunctionNode(model: VizFunctionNodeModel): Ref<VizFunctionNode> {
  return ref({ model, ...model });
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
