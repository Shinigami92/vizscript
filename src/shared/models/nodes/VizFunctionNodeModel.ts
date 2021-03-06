import { Parameter } from '../Parameter';
import { Return } from '../Return';
import { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizFunctionNodeModel extends AbstractVizNodeModel<'function'> {
  title: string;
  parameters: Parameter[];
  return: Return;
}
