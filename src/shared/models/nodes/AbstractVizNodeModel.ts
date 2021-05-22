import { IdModel } from '@/shared/models/IdModel';
import { PositionModel } from '@/shared/models/PositionModel';

export interface AbstractVizNodeModel<Type extends string> extends IdModel, PositionModel {
  readonly type: Type;
}
