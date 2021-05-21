<template lang="pug">
.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown',
  @mousemove='onMousemove',
  @mouseup='onMouseup'
)
  .header
    .title SET
  .body
    .inputs
      icon(:size='48') mdi-arrow-right-bold-outline
      span value
      span target
    .outputs
      icon(:size='48') mdi-arrow-right-bold-outline
      span result
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import type { VizSetModel } from '@/shared/VizSetModel';
import { computed, defineComponent, PropType, Ref, ref, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizFunction',
  components: { Icon },
  props: { modelValue: { type: Object as PropType<VizSetModel>, required: true } },
  emits: {
    'update:modelValue': (modelValue: VizSetModel) => {
      if (typeof modelValue.x !== 'number') {
        return false;
      }
      if (typeof modelValue.y !== 'number') {
        return false;
      }
      return true;
    }
  },
  setup(props, { emit }) {
    const internalValue: WritableComputedRef<VizSetModel> = computed({
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
});
</script>

<style lang="postcss" scoped>
.shape {
  @apply absolute max-w-64 grid grid-rows-[48px,1fr] rounded shadow text-primary-50 bg-background-400;

  .header {
    @apply flex items-center justify-center rounded-t bg-green-300;

    .title {
      @apply text-xl text-primary-50;
    }
  }

  .body {
    @apply grid grid-cols-[1fr,1fr] justify-between rounded-b bg-background-400;

    .inputs {
      @apply flex flex-col items-start;
    }

    .outputs {
      @apply flex flex-col items-end;
    }
  }
}
</style>
