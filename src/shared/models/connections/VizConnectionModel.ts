import type { VizEventConnectionModel } from './VizEventConnectionModel';
import type { VizSlotConnectionModel } from './VizSlotConnectionModel';

export type VizConnectionModel =
  | VizEventConnectionModel
  | VizSlotConnectionModel;
