import { isPositionable, Positionable } from './Positionable';

export interface VizSetModel extends Positionable {}

export function isVizSetModel(modelValue: unknown): modelValue is VizSetModel {
  return isPositionable(modelValue);
}
