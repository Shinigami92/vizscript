import { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizFunctionNodeModel extends AbstractVizNodeModel<'function'> {
  title: string;
}
