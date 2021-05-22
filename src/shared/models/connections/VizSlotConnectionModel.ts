import { AbstractVizConnectionModel } from './AbstractVizConnectionModel';

export interface VizSlotConnectionModel extends AbstractVizConnectionModel<'slot'> {
  startSlot: number;
  endSlot: number;
}
