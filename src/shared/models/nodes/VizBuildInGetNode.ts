import type { DataType } from '../DataType';
import type { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizBuildInGetNodeModel
  extends AbstractVizNodeModel<'build-in-get'> {
  name: string;
  dataType: DataType;
}
