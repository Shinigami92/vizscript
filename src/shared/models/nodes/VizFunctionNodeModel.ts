import { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface Parameter {
  name: string;
  type: 'string';
}

export interface Return {
  type: 'string';
}

export interface VizFunctionNodeModel extends AbstractVizNodeModel<'function'> {
  title: string;
  parameters: Parameter[];
  return: Return;
}
