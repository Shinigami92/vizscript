import { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import { Positionable } from '@/shared/viz-components/Positionable';

export interface AbstractVizConnection<Type extends string> {
  model?: VizConnectionModel;
  readonly type: Type;
  start: Positionable;
  end: Positionable;
}
