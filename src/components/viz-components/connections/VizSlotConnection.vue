<template lang="pug">
.viz-connection.viz-event-connection.shape(ref='connection', :style='{ left: `${left}px`, top: `${top}px` }')
  template(v-if='xFlip')
    template(v-if='yFlip')
      svg(:width='width', :height='height + 4')
        path(
          :d='`M 0 2 C ${40} 2, ${width - 40} ${height + 2}, ${width} ${height + 2}`',
          stroke='white',
          stroke-width='4',
          fill='transparent'
        )
      icon.absolute(:style='{ left: `${-8}px`, top: `${-8 - 2}px` }') mdi-circle
      icon.absolute(:style='{ left: `${width + -8}px`, top: `${height + -8 - 2}px` }') mdi-circle
    template(v-else)
      svg(:width='width', :height='height + 4')
        path(
          :d='`M 0 ${height + 2} C ${40}  ${height + 2}, ${width - 40} 2, ${width} 2`',
          stroke='white',
          stroke-width='4',
          fill='transparent'
        )
      icon.absolute(:style='{ left: `${-8}px`, top: `${height + -8 - 2}px` }') mdi-circle
      icon.absolute(:style='{ left: `${width + -8}px`, top: `${-8 - 2}px` }') mdi-circle
  template(v-else)
    template(v-if='yFlip')
      svg(:width='width', :height='height + 4')
        path(
          :d='`M ${width} 2 C ${width - 40} 2, ${40} ${height + 2}, 0 ${height + 2}`',
          stroke='white',
          stroke-width='4',
          fill='transparent'
        )
      icon.absolute(:style='{ left: `${width + -8}px`, top: `${-8 - 2}px` }') mdi-circle
      icon.absolute(:style='{ left: `${-8}px`, top: `${height + -8 - 2}px` }') mdi-circle
    template(v-else)
      svg(:width='width', :height='height + 4')
        path(
          :d='`M ${width} ${height + 2} C ${width - 40}  ${height + 2}, ${40} 2, 0 2`',
          stroke='white',
          stroke-width='4',
          fill='transparent'
        )
      icon.absolute(:style='{ left: `${width + -8}px`, top: `${height + -8 - 2}px` }') mdi-circle
      icon.absolute(:style='{ left: `${-8}px`, top: `${-8 - 2}px` }') mdi-circle
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import type { EmitType } from '@/shared/utilities/vue';
import { isSlotConnection, VizSlotConnection } from '@/shared/viz-components/connections/VizSlotConnection';
import { computed, ComputedRef, defineComponent, PropType, Ref, ref, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizSlotConnection',
  components: { Icon },
  props: { modelValue: { type: Object as PropType<VizSlotConnection>, required: true } },
  emits: { 'update:modelValue': isSlotConnection as EmitType<VizSlotConnection> },
  setup(props, { emit }) {
    const internalValue: WritableComputedRef<VizSlotConnection> = computed({
      get: () => props.modelValue,
      set: (value) => emit('update:modelValue', value)
    });
    console.debug('Unused const', internalValue);
    const connection: Ref<HTMLDivElement | undefined> = ref();
    const left: ComputedRef<number> = computed(() => Math.min(props.modelValue.start.x, props.modelValue.end.x));
    const top: ComputedRef<number> = computed(() => Math.min(props.modelValue.start.y, props.modelValue.end.y));
    const xFlip: ComputedRef<boolean> = computed(() => props.modelValue.end.x - left.value > 0);
    const yFlip: ComputedRef<boolean> = computed(() => props.modelValue.end.y - top.value > 0);
    const width: ComputedRef<number> = computed(() =>
      xFlip.value ? props.modelValue.end.x - left.value : props.modelValue.start.x - left.value
    );
    const height: ComputedRef<number> = computed(() =>
      yFlip.value ? props.modelValue.end.y - top.value : props.modelValue.start.y - top.value
    );
    return { connection, left, top, width, height, xFlip, yFlip };
  }
});
</script>

<style lang="postcss" scoped>
.viz-connection {
  @apply absolute pointer-events-none;
}

.viz-event-connection.shape {
  @apply text-primary-50;
}
</style>
