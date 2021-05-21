import { isPositionable, Positionable } from './Positionable';

export interface VizEventStartModel extends Positionable {}

export function isVizEventStartModel(modelValue: unknown): modelValue is VizEventStartModel {
  return isPositionable(modelValue);
}
