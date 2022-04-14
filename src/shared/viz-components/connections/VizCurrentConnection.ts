import type { PositionModel } from '@/shared/models/PositionModel';
import { isRecordObject } from '@/shared/utilities/common';

interface VizCurrentEventConnection {
  type: 'event';
  startPosition: PositionModel;
  startNodeId: string;
}

interface VizCurrentSlotConnection {
  type: 'slot';
  startPosition: PositionModel;
  startNodeId: string;
  startSlot: number;
}

export type VizCurrentConnection =
  | VizCurrentEventConnection
  | VizCurrentSlotConnection;

export function isCurrentConnection(
  modelValue: unknown,
): modelValue is VizCurrentConnection {
  if (!isRecordObject(modelValue)) {
    return false;
  }
  if (typeof modelValue.startNodeId !== 'string') {
    return false;
  }
  return true;
}
