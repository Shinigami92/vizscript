import type { VizConnectionModel } from '@/shared/models/connections/VizConnectionModel';
import type { Positionable } from '@/shared/viz-components/Positionable';
import type { VizNode } from '../nodes/VizNode';

export interface AbstractVizConnection<Type extends string> {
  model?: VizConnectionModel;
  readonly type: Type;
  start: Positionable;
  startNode?: VizNode;
  end: Positionable;
  endNode?: VizNode;
}
