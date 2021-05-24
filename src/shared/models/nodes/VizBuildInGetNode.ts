import { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizBuildInGetNodeModel extends AbstractVizNodeModel<'build-in-get'> {
  name: string;
}
