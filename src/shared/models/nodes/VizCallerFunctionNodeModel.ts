import { DataType } from '../DataType';
import { Parameter } from '../Parameter';
import { Return } from '../Return';
import { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizCallerFunctionNodeModel extends AbstractVizNodeModel<'caller-function'> {
  title: string;
  caller: { type: DataType };
  parameters: Parameter[];
  return: Return;
}
