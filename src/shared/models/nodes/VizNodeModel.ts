import { VizEventStartNodeModel } from './VizEventStartNodeModel';
import { VizFunctionNodeModel } from './VizFunctionNodeModel';
import { VizSetNodeModel } from './VizSetNodeModel';
import { VizVariableGetNodeModel } from './VizVariableGetNodeModel';

export type VizNodeModel = VizFunctionNodeModel | VizEventStartNodeModel | VizSetNodeModel | VizVariableGetNodeModel;
