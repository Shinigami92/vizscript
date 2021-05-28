import { VizNodeModel } from '@/shared/models/nodes/VizNodeModel';
import { isRecordObject } from '@/shared/utilities/common';
import { Ref } from 'vue';
import { isPositionable } from '../Positionable';
import { convertBuildInGetNode, VizBuildInGetNode } from './VizBuildInGetNode';
import { convertCallerFunctionNode, VizCallerFunctionNode } from './VizCallerFunctionNode';
import { convertEventStartNode, VizEventStartNode } from './VizEventStartNode';
import { convertFunctionNode, VizFunctionNode } from './VizFunctionNode';
import { convertSetNode, VizSetNode } from './VizSetNode';
import { convertVariableGetNode, VizVariableGetNode } from './VizVariableGetNode';

export type VizNode =
  | VizCallerFunctionNode
  | VizEventStartNode
  | VizFunctionNode
  | VizSetNode
  | VizBuildInGetNode
  | VizVariableGetNode;

export function isNode(modelValue: unknown): modelValue is VizNode {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (!isPositionable(modelValue)) {
    return false;
  }
  return true;
}

export function convertNode(model: VizNodeModel): Ref<VizNode> {
  switch (model.type) {
    case 'event-start':
      return convertEventStartNode(model);
    case 'caller-function':
      return convertCallerFunctionNode(model);
    case 'function':
      return convertFunctionNode(model);
    case 'set':
      return convertSetNode(model);
    case 'build-in-get':
      return convertBuildInGetNode(model);
    case 'variable-get':
      return convertVariableGetNode(model);
  }
  throw Error('Unsupported');
}
