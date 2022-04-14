import type { IdModel } from '@/shared/models/IdModel';

export interface AbstractVizConnectionModel<Type extends string>
  extends IdModel {
  readonly type: Type;
  startNodeId: string;
  endNodeId: string;
}
