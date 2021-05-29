import type { Ref } from 'vue';

export interface PositionModel {
  x: number;
  y: number;
}

export interface RefPositionModel {
  x: Ref<number>;
  y: Ref<number>;
}
