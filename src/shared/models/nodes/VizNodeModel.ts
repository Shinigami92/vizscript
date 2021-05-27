import type { VizBuildInGetNodeModel } from './VizBuildInGetNode';
import type { VizCallerFunctionNodeModel } from './VizCallerFunctionNodeModel';
import type { VizEventStartNodeModel } from './VizEventStartNodeModel';
import type { VizFunctionNodeModel } from './VizFunctionNodeModel';
import type { VizSetNodeModel } from './VizSetNodeModel';
import type { VizVariableGetNodeModel } from './VizVariableGetNodeModel';

export type VizNodeModel =
  | VizCallerFunctionNodeModel
  | VizFunctionNodeModel
  | VizEventStartNodeModel
  | VizSetNodeModel
  | VizBuildInGetNodeModel
  | VizVariableGetNodeModel;

export type VizNodeType = VizNodeModel['type'];
