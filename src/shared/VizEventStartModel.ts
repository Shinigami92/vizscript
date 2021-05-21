import { isPositionable, Positionable } from './Positionable';

export interface VizEventStartModel extends Positionable {
  type: 'event-start';
}

export function isVizEventStartModel(modelValue: unknown): modelValue is VizEventStartModel {
  return isPositionable(modelValue);
}
