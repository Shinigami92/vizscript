import { AbstractVizNodeModel } from '@/shared/models/nodes/AbstractVizNodeModel';
import { Positionable } from '@/shared/viz-components/Positionable';

export interface AbstractVizNode<Type extends string> extends Positionable {
  model?: AbstractVizNodeModel<Type>;
  type: Type;
}
