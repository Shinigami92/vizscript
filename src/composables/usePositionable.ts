import type { Positionable } from '@/shared/viz-components/Positionable';
import { computed, ref, Ref, WritableComputedRef } from 'vue';

export interface UsePositionable<T extends Positionable> {
  dx: Ref<number>;
  dy: Ref<number>;
  onMousedown: (payload: MouseEvent) => void;
}

export function usePositionable<T extends Positionable>(
  props: { modelValue: T },
  emit: (event: 'update:modelValue', value: T) => void
): UsePositionable<T> {
  const internalValue: WritableComputedRef<Positionable> = computed({
    get: () => props.modelValue,
    set: (value) => emit('update:modelValue', value)
  });

  const dx: Ref<number> = ref(0);
  const dy: Ref<number> = ref(0);

  // let initialPos: Positionable | null = null;
  let startPos: Positionable | null = null;
  const onMousemove: (event: MouseEvent) => void = (payload) => {
    if (startPos) {
      dx.value = payload.clientX - startPos.x;
      dy.value = payload.clientY - startPos.y;
      internalValue.value.x += dx.value;
      internalValue.value.y += dy.value;
      dx.value = 0;
      dy.value = 0;
      startPos = { x: payload.clientX, y: payload.clientY };
    }
  };

  const onMousedown: (payload: MouseEvent) => void = (payload) => {
    // initialPos = { x: payload.clientX, y: payload.clientY };
    startPos = { x: payload.clientX, y: payload.clientY };
    window.addEventListener('mousemove', onMousemove);
    window.addEventListener('mouseup', onMouseup);
  };

  const onMouseup: (payload: MouseEvent) => void = () => {
    window.removeEventListener('mousemove', onMousemove);
    window.removeEventListener('mouseup', onMouseup);
    internalValue.value.x += dx.value;
    internalValue.value.y += dy.value;
    dx.value = 0;
    dy.value = 0;
    startPos = null;
    // initialPos = null;
  };

  return { dx, dy, onMousedown };
}
