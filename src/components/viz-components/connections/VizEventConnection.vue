<template lang="pug">
.viz-event-connection.shape(ref='connection', :style='{ left: `${left}px`, top: `${top}px` }')
  svg(:width='width', :height='height + 4')
    path(
      :d='`M 0 2 C ${40} 2, ${width - 40} ${height + 2}, ${width} ${height + 2}`',
      stroke='white',
      stroke-width='4',
      fill='transparent'
    )
  icon.absolute(:style='{ left: `${-8}px`, top: `${-8 - 2}px` }') mdi-circle
  icon.absolute(:style='{ left: `${width + -8}px`, top: `${height + -8 - 2}px` }') mdi-circle
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import type { EmitType } from '@/shared/utilities/vue';
import { isVizEventConnectionModel, VizEventConnectionModel } from '@/shared/VizEventConnectionModel';
import { computed, ComputedRef, defineComponent, PropType, Ref, ref, WritableComputedRef } from 'vue';
export default defineComponent({
  name: 'VizEventConnection',
  components: { Icon },
  props: { modelValue: { type: Object as PropType<VizEventConnectionModel>, required: true } },
  emits: { 'update:modelValue': isVizEventConnectionModel as EmitType<VizEventConnectionModel> },
  setup(props, { emit }) {
    const internalValue: WritableComputedRef<VizEventConnectionModel> = computed({
      get: () => props.modelValue,
      set: (value) => emit('update:modelValue', value)
    });
    console.log(internalValue);
    const connection: Ref<HTMLDivElement | undefined> = ref();
    const left: ComputedRef<number> = computed(() => Math.min(props.modelValue.start.x, props.modelValue.end.x));
    const top: ComputedRef<number> = computed(() => Math.min(props.modelValue.start.y, props.modelValue.end.y));
    const width: ComputedRef<number> = computed(() => props.modelValue.end.x - left.value);
    const height: ComputedRef<number> = computed(() => props.modelValue.end.y - top.value);
    return { connection, left, top, width, height };
  }
});
</script>

<style lang="postcss" scoped>
.viz-event-connection.shape {
  @apply absolute text-primary-50;
  pointer-events: none;

  svg {
    /* pointer-events: none; */
  }
}
</style>
