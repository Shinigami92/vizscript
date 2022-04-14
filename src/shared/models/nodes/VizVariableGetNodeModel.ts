import type { DataType } from '../DataType';
import type { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizVariableGetNodeModel
  extends AbstractVizNodeModel<'variable-get'> {
  name: string;
  dataType: DataType;
}
