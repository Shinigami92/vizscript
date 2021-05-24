import { VizBuildInGetNodeModel } from './VizBuildInGetNode';
import { VizCallerFunctionNodeModel } from './VizCallerFunctionNodeModel';
import { VizEventStartNodeModel } from './VizEventStartNodeModel';
import { VizFunctionNodeModel } from './VizFunctionNodeModel';
import { VizSetNodeModel } from './VizSetNodeModel';
import { VizVariableGetNodeModel } from './VizVariableGetNodeModel';

export type VizNodeModel =
  | VizCallerFunctionNodeModel
  | VizFunctionNodeModel
  | VizEventStartNodeModel
  | VizSetNodeModel
  | VizBuildInGetNodeModel
  | VizVariableGetNodeModel;
