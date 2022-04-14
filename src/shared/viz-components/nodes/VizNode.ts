import type { VizNodeModel } from '@/shared/models/nodes/VizNodeModel';
import { isRecordObject } from '@/shared/utilities/common';
import type { Ref } from 'vue';
import { isPositionable } from '../Positionable';
import type { VizBuildInGetNode } from './VizBuildInGetNode';
import { convertBuildInGetNode } from './VizBuildInGetNode';
import type { VizCallerFunctionNode } from './VizCallerFunctionNode';
import { convertCallerFunctionNode } from './VizCallerFunctionNode';
import type { VizEventStartNode } from './VizEventStartNode';
import { convertEventStartNode } from './VizEventStartNode';
import type { VizFunctionNode } from './VizFunctionNode';
import { convertFunctionNode } from './VizFunctionNode';
import type { VizSetNode } from './VizSetNode';
import { convertSetNode } from './VizSetNode';
import type { VizVariableGetNode } from './VizVariableGetNode';
import { convertVariableGetNode } from './VizVariableGetNode';

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
