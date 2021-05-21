<template lang="pug">
.viz-event-start.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown',
  @mousemove='onMousemove',
  @mouseup='onMouseup'
)
  .header
    icon(:size='32') mdi-arrow-right-bold-hexagon-outline
    .title Event Start
  .body
    icon(:size='48') mdi-arrow-right-bold-outline
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import type { VizEventStartModel } from '@/shared/VizEventStartModel';
import { computed, defineComponent, PropType, Ref, ref, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizEventStart',
  components: { Icon },
  props: { modelValue: { type: Object as PropType<VizEventStartModel>, required: true } },
  emits: {
    'update:modelValue': (modelValue: VizEventStartModel) => {
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
    const internalValue: WritableComputedRef<VizEventStartModel> = computed({
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
.viz-event-start.shape {
  @apply absolute w-48 grid grid-rows-[48px,1fr] rounded shadow text-primary-50 bg-background-400;

  .header {
    @apply flex items-center rounded-t bg-red-400;

    .icon {
      @apply mx-2 text-primary-50;
    }

    .title {
      @apply text-xl text-primary-50;
    }
  }

  .body {
    @apply flex items-center justify-end rounded-b bg-background-400;
  }
}
</style>
