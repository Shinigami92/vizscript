import type { Parameter } from '../Parameter';
import type { Return } from '../Return';
import type { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizFunctionNodeModel extends AbstractVizNodeModel<'function'> {
  title: string;
  parameters: Parameter[];
  return: Return;
}
