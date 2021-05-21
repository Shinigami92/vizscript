import type { Positionable } from '@/shared/Positionable';
import { computed, ref, Ref, WritableComputedRef } from 'vue';

export interface UsePositionable<T extends Positionable> {
  dx: Ref<number>;
  dy: Ref<number>;
  onMousedown: (payload: MouseEvent) => void;
  onMousemove: (payload: MouseEvent) => void;
  onMouseup: (payload: MouseEvent) => void;
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
  let startPos: { x: number; y: number } | null = null;
  const onMousedown: (payload: MouseEvent) => void = (payload) => {
    startPos = { x: payload.clientX, y: payload.clientY };
  };
  const onMousemove: (payload: MouseEvent) => void = (payload) => {
    if (startPos) {
      dx.value = payload.clientX - startPos.x;
      dy.value = payload.clientY - startPos.y;
    }
  };
  const onMouseup: (payload: MouseEvent) => void = () => {
    internalValue.value.x = internalValue.value.x + dx.value;
    internalValue.value.y = internalValue.value.y + dy.value;
    dx.value = 0;
    dy.value = 0;
    startPos = null;
  };
  return { dx, dy, onMousedown, onMousemove, onMouseup };
}
