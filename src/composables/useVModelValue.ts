import type { WritableComputedRef } from 'vue';
import { computed } from 'vue';

export function useVModelValue<T>(
  props: { modelValue: T },
  emit: (event: 'update:modelValue', value: T) => void,
): WritableComputedRef<T> {
  return computed({
    get: () => props.modelValue,
    set: (value) => emit('update:modelValue', value),
  });
}
