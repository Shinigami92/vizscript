import { VizNodeModel } from '@/shared/models/nodes/VizNodeModel';
import { Ref } from 'vue';
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
