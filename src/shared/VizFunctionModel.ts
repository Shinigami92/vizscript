import { isPositionable, Positionable } from './Positionable';
import { isRecordObject } from './utilities/common';

export interface VizFunctionModel extends Positionable {
  type: 'function';
  title: string;
}

export function isVizFunctionModel(modelValue: unknown): modelValue is VizFunctionModel {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (typeof modelValue !== 'string') {
    return false;
  }
  if (!isPositionable(modelValue)) {
    return false;
  }
  return true;
}
