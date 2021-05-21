<template lang="pug">
.shape(
  :style='{ left: `${x + dx}px`, top: `${y + dy}px` }',
  @mousedown='onMousedown',
  @mousemove='onMousemove',
  @mouseup='onMouseup'
)
  .header
    icon(:size='32') mdi-math-integral
    .title {{ title }}
  .body
    icon(:size='48') mdi-arrow-right-bold-outline
    icon(:size='48') mdi-arrow-right-bold-outline
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import { computed, defineComponent, Ref, ref, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizFunction',
  components: { Icon },
  props: {
    title: {
      type: String,
      default: ''
    },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  emits: {
    'update:x': (x: number) => typeof x === 'number',
    'update:y': (y: number) => typeof y === 'number'
  },
  setup(props, { emit }) {
    const x: WritableComputedRef<number> = computed({ get: () => props.x, set: (value) => emit('update:x', value) });
    const y: WritableComputedRef<number> = computed({ get: () => props.y, set: (value) => emit('update:y', value) });
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
      x.value = x.value + dx.value;
      y.value = y.value + dy.value;
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
  @apply absolute max-w-64 grid grid-rows-[48px,64px] rounded shadow text-primary-50 bg-background-400;

  .header {
    @apply flex items-center rounded-t bg-blue-300;

    .icon {
      @apply mx-2 text-primary-50;
    }

    .title {
      @apply text-xl ml-2 mr-4 text-primary-50;
    }
  }

  .body {
    @apply flex items-center justify-between rounded-b bg-background-400;
  }
}
</style>
