import type { PositionModel } from '../PositionModel';

interface VizCurrentEventConnectionModel {
  type: 'event';
  startPosition: PositionModel;
  startNodeId: string;
}

interface VizCurrentSlotConnectionModel {
  type: 'slot';
  startPosition: PositionModel;
  startNodeId: string;
  startSlot: number;
}

export type VizCurrentConnectionModel =
  | VizCurrentEventConnectionModel
  | VizCurrentSlotConnectionModel;
