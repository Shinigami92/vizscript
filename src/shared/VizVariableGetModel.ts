import { isPositionable, Positionable } from './Positionable';
import { isRecordObject } from './utilities/common';

export interface VizVariableGetModel extends Positionable {
  type: 'variable-get';
  name: string;
}

export function isVizVariableGetModel(modelValue: unknown): modelValue is VizVariableGetModel {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (typeof modelValue.name !== 'string') {
    return false;
  }
  if (!isPositionable(modelValue)) {
    return false;
  }
  return true;
}
