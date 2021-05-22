import { VizNodeModel } from '@/shared/models/nodes/VizNodeModel';
import { Ref } from 'vue';
import { convertEventStartNode, VizEventStartNode } from './VizEventStartNode';
import { convertFunctionNode, VizFunctionNode } from './VizFunctionNode';
import { convertSetNode, VizSetNode } from './VizSetNode';
import { convertVariableGetNode, VizVariableGetNode } from './VizVariableGetNode';

export type VizNode = VizEventStartNode | VizFunctionNode | VizSetNode | VizVariableGetNode;

export function convertNode(model: VizNodeModel): Ref<VizNode> {
  switch (model.type) {
    case 'event-start':
      return convertEventStartNode(model);
    case 'function':
      return convertFunctionNode(model);
    case 'set':
      return convertSetNode(model);
    case 'variable-get':
      return convertVariableGetNode(model);
  }
  throw Error('Unsupported');
}
