<template lang="pug">
.viz-connection.viz-current-connection.shape(
  ref='connection',
  :style='{ left: `${left - padding}px`, top: `${top - padding}px` }'
)
  svg(:width='width + padding * 2', :height='height + 4 + padding * 2')
    path(:d='d', stroke='white', stroke-width='4', fill='transparent')
  icon.absolute(:style='{ left: `${iconX1}px`, top: `${iconY1}px` }') mdi-circle
  icon.absolute(:style='{ left: `${iconX2}px`, top: `${iconY2}px` }') mdi-circle
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import { VizCurrentConnectionModel } from '@/shared/models/connections/VizCurrentConnectionModel';
import { PositionModel, RefPositionModel } from '@/shared/models/PositionModel';
import { computed, ComputedRef, defineComponent, PropType, Ref, ref } from 'vue';
export default defineComponent({
  name: 'VizCurrentConnection',
  components: { Icon },
  props: {
    currentConnection: { type: Object as PropType<VizCurrentConnectionModel>, required: true },
    pointerPosition: { type: Object as PropType<RefPositionModel>, required: true }
  },
  setup(props) {
    const startPosition: Ref<PositionModel> = computed(() => ({
      x: props.currentConnection.startPosition.x - 320,
      y: props.currentConnection.startPosition.y - 56
    }));
    const connection: Ref<HTMLDivElement | undefined> = ref();
    const left: ComputedRef<number> = computed(() => Math.min(startPosition.value.x, props.pointerPosition.x.value));
    const top: ComputedRef<number> = computed(() => Math.min(startPosition.value.y, props.pointerPosition.y.value));
    const xFlip: ComputedRef<boolean> = computed(() => props.pointerPosition.x.value - left.value > 0);
    const yFlip: ComputedRef<boolean> = computed(() => props.pointerPosition.y.value - top.value > 0);
    const width: ComputedRef<number> = computed(() =>
      xFlip.value ? props.pointerPosition.x.value - left.value : startPosition.value.x - left.value
    );
    const height: ComputedRef<number> = computed(() =>
      yFlip.value ? props.pointerPosition.y.value - top.value : startPosition.value.y - top.value
    );
    const strokeColor: ComputedRef<string> = computed(() => {
      return 'white';
    });
    const padding: number = 30;
    const strength: number = 60;
    const d: ComputedRef<string> = computed(() => {
      if (xFlip.value)
        if (yFlip.value)
          return `M ${padding} ${padding + 2} C ${padding + strength} ${padding + 2}, ${
            width.value + padding - strength
          } ${height.value + padding + 2}, ${width.value + padding} ${height.value + padding + 2}`;
        else
          return `M ${padding} ${height.value + padding + 2} C ${strength + padding}  ${height.value + padding + 2}, ${
            width.value + padding - strength
          } ${padding + 2}, ${width.value + padding} ${padding + 2}`;
      else if (yFlip.value)
        return `M ${width.value + padding} ${padding + 2} C ${width.value + padding - strength} ${padding + 2}, ${
          strength + padding
        } ${height.value + padding + 2}, ${padding} ${height.value + padding + 2}`;
      return `M ${width.value + padding} ${height.value + padding + 2} C ${width.value + padding - strength} ${
        height.value + padding + 2
      }, ${strength + padding} ${padding + 2}, ${padding} ${padding + 2}`;
    });
    const iconX1: ComputedRef<number> = computed(() => {
      if (xFlip.value)
        if (yFlip.value) return padding - 8;
        else return padding - 8;
      else if (yFlip.value) return width.value + padding + -8;
      return width.value + padding + -8;
    });
    const iconY1: ComputedRef<number> = computed(() => {
      if (xFlip.value)
        if (yFlip.value) return padding - 8 - 2;
        else return height.value + padding + -8 - 2;
      else if (yFlip.value) return padding - 8 - 2;
      return height.value + padding + -8 - 2;
    });
    const iconX2: ComputedRef<number> = computed(() => {
      if (xFlip.value)
        if (yFlip.value) return width.value + padding + -8;
        else return width.value + padding + -8;
      else if (yFlip.value) return padding - 8;
      return padding - 8;
    });
    const iconY2: ComputedRef<number> = computed(() => {
      if (xFlip.value)
        if (yFlip.value) return height.value + padding + -8 - 2;
        else return padding - 8 - 2;
      else if (yFlip.value) return height.value + padding + -8 - 2;
      return padding - 8 - 2;
    });
    return { connection, left, top, width, height, strokeColor, d, iconX1, iconY1, iconX2, iconY2, padding };
  }
});
</script>

<style lang="postcss" scoped>
.viz-connection {
  @apply absolute pointer-events-none;
}

.viz-current-connection.shape {
  @apply text-primary-50;
}
</style>
