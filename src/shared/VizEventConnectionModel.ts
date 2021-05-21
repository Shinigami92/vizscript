import { isPositionable, Positionable } from './Positionable';
import { isRecordObject } from './utilities/common';

export interface VizEventConnectionModel {
  start: Positionable;
  end: Positionable;
}

export function isVizEventConnectionModel(modelValue: unknown): modelValue is VizEventConnectionModel {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (!isPositionable(modelValue.start)) {
    return false;
  }
  if (!isPositionable(modelValue.end)) {
    return false;
  }
  return true;
}
