import { DataType } from '../DataType';
import { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizVariableGetNodeModel extends AbstractVizNodeModel<'variable-get'> {
  name: string;
  dataType: DataType;
}
