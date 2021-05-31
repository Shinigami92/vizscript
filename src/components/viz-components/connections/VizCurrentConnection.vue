<template lang="pug">
.viz-connection.viz-current-connection.shape(ref='connection', :style='{ left: `${left}px`, top: `${top}px` }')
  template(v-if='xFlip')
    template(v-if='yFlip')
      svg(:width='width', :height='height + 4')
        path(
          :d='`M 0 2 C ${40} 2, ${width - 40} ${height + 2}, ${width} ${height + 2}`',
          :stroke='strokeColor',
          stroke-width='4',
          fill='transparent'
        )
      icon.absolute(:style='{ left: `${-8}px`, top: `${-8 - 2}px` }') mdi-circle
      icon.absolute(:style='{ left: `${width + -8}px`, top: `${height + -8 - 2}px` }') mdi-circle
    template(v-else)
      svg(:width='width', :height='height + 4')
        path(
          :d='`M 0 ${height + 2} C ${40}  ${height + 2}, ${width - 40} 2, ${width} 2`',
          :stroke='strokeColor',
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
          :stroke='strokeColor',
          stroke-width='4',
          fill='transparent'
        )
      icon.absolute(:style='{ left: `${width + -8}px`, top: `${-8 - 2}px` }') mdi-circle
      icon.absolute(:style='{ left: `${-8}px`, top: `${height + -8 - 2}px` }') mdi-circle
    template(v-else)
      svg(:width='width', :height='height + 4')
        path(
          :d='`M ${width} ${height + 2} C ${width - 40}  ${height + 2}, ${40} 2, 0 2`',
          :stroke='strokeColor',
          stroke-width='4',
          fill='transparent'
        )
      icon.absolute(:style='{ left: `${width + -8}px`, top: `${height + -8 - 2}px` }') mdi-circle
      icon.absolute(:style='{ left: `${-8}px`, top: `${-8 - 2}px` }') mdi-circle
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
    return { connection, left, top, width, height, xFlip, yFlip, strokeColor };
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
