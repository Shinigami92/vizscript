import type { Positionable } from './Positionable';
import type { VizEventStartModel } from './VizEventStartModel';
import type { VizFunctionModel } from './VizFunctionModel';
import type { VizSetModel } from './VizSetModel';
import type { VizVariableGetModel } from './VizVariableGetModel';

export type VizComponentModel = VizEventStartModel | VizVariableGetModel | VizFunctionModel | VizSetModel;

export function calculateInputEventReceiverPosition(vizComponent: VizComponentModel): Positionable {
  switch (vizComponent.type) {
    case 'function':
      return { x: vizComponent.x, y: vizComponent.y + 82 };
    default:
      throw Error('Unsupported');
  }
}

export function calculateOutputEventEmitterPosition(vizComponent: VizComponentModel): Positionable {
  switch (vizComponent.type) {
    case 'event-start':
      return { x: vizComponent.x + 192, y: vizComponent.y + 82 };
    default:
      throw Error('Unsupported');
  }
}
