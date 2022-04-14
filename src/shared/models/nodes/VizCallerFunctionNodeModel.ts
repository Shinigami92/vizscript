import type { DataType } from '../DataType';
import type { Parameter } from '../Parameter';
import type { Return } from '../Return';
import type { AbstractVizNodeModel } from './AbstractVizNodeModel';

export interface VizCallerFunctionNodeModel
  extends AbstractVizNodeModel<'caller-function'> {
  title: string;
  caller: { type: DataType };
  parameters: Parameter[];
  return: Return;
}
