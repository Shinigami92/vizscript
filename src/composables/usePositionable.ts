import type { VizNode } from '@/shared/viz-components/nodes/VizNode';
import type { Positionable } from '@/shared/viz-components/Positionable';
import { updateNodePosition } from '@/store';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { useVModelValue } from './useVModelValue';

export interface UsePositionable<T extends VizNode> {
  dx: Ref<number>;
  dy: Ref<number>;
  onPointerdown: (payload: PointerEvent) => void;
}

export function usePositionable<T extends VizNode>(
  props: { modelValue: T },
  emit: (event: 'update:modelValue', value: T) => void,
): UsePositionable<T> {
  const modelValue = useVModelValue(props, emit);
  const dx = ref(0);
  const dy = ref(0);

  // let initialPos: Positionable | null = null;
  let startPos: Positionable | null = null;
  function onPointermove(payload: PointerEvent): void {
    if (startPos) {
      dx.value = payload.clientX - startPos.x;
      dy.value = payload.clientY - startPos.y;
      modelValue.value.x += dx.value;
      modelValue.value.y += dy.value;
      dx.value = 0;
      dy.value = 0;
      startPos = { x: payload.clientX, y: payload.clientY };
    }
  }

  function onPointerdown(payload: PointerEvent): void {
    // initialPos = { x: payload.clientX, y: payload.clientY };
    startPos = { x: payload.clientX, y: payload.clientY };
    window.addEventListener('pointermove', onPointermove);
    window.addEventListener('pointerup', onPointerup);
  }

  function onPointerup(payload: PointerEvent): void {
    window.removeEventListener('pointermove', onPointermove);
    window.removeEventListener('pointerup', onPointerup);
    modelValue.value.x += dx.value;
    modelValue.value.y += dy.value;
    dx.value = 0;
    dy.value = 0;
    startPos = null;
    // initialPos = null;

    const nodeId: string | undefined = modelValue.value.model?.id;
    if (nodeId) {
      updateNodePosition(nodeId, modelValue.value);
    }
  }

  return { dx, dy, onPointerdown };
}
