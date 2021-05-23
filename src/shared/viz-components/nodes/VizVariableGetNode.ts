import { VizVariableGetNodeModel } from '@/shared/models/nodes/VizVariableGetNodeModel';
import { isRecordObject } from '@/shared/utilities/common';
import { isPositionable } from '@/shared/viz-components/Positionable';
import { ref, Ref } from 'vue';
import { AbstractVizNode } from './AbstractVizNode';

export interface VizVariableGetNode extends AbstractVizNode<'variable-get'> {
  name: string;
}

export function convertVariableGetNode(model: VizVariableGetNodeModel): Ref<VizVariableGetNode> {
  return ref<VizVariableGetNode>({ model, ...model });
}

export function isVariableGetNode(modelValue: unknown): modelValue is VizVariableGetNode {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (typeof modelValue.name !== 'string') {
    return false;
  }
  if (!isPositionable(modelValue)) {
    return false;
  }
  return true;
}
