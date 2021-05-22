import { isRecordObject } from '../utilities/common';

export interface Positionable {
  x: number;
  y: number;
}

export function isPositionable(value: unknown): value is Positionable {
  if (!isRecordObject(value)) {
    return false;
  }
  if (typeof value.x !== 'number') {
    return false;
  }
  if (typeof value.y !== 'number') {
    return false;
  }
  return true;
}
