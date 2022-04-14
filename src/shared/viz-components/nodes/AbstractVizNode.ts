import type { AbstractVizNodeModel } from '@/shared/models/nodes/AbstractVizNodeModel';
import type { Positionable } from '@/shared/viz-components/Positionable';

export interface AbstractVizNode<Type extends string> extends Positionable {
  model?: AbstractVizNodeModel<Type>;
  type: Type;
  vizNodeDivRef?: HTMLDivElement;
}
