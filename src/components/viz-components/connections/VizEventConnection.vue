<template lang="pug">
.viz-connection.viz-event-connection.shape(
  ref="connection",
  :style="{ left: `${left - padding}px`, top: `${top - padding}px` }"
)
  svg(:width="width + padding * 2", :height="height + 4 + padding * 2")
    path(stroke="white", stroke-width="4", fill="transparent", :d="d")
  icon.absolute(:style="{ left: `${iconX1}px`, top: `${iconY1}px` }") mdi-circle
  icon.absolute(:style="{ left: `${iconX2}px`, top: `${iconY2}px` }") mdi-circle
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizEventConnection } from '@/shared/viz-components/connections/VizEventConnection';
import { isEventConnection } from '@/shared/viz-components/connections/VizEventConnection';
import type { ComputedRef, PropType, Ref, WritableComputedRef } from 'vue';
import { computed, defineComponent, ref } from 'vue';

export default defineComponent({
  name: 'VizEventConnection',
  components: { Icon },
  props: {
    modelValue: {
      type: Object as PropType<VizEventConnection>,
      required: true,
    },
  },
  emits: {
    'update:modelValue': isEventConnection as EmitType<VizEventConnection>,
  },
  setup(props, { emit }) {
    const internalValue: WritableComputedRef<VizEventConnection> = computed({
      get: () => props.modelValue,
      set: (value) => emit('update:modelValue', value),
    });

    console.debug('Unused const', internalValue);

    const connection: Ref<HTMLDivElement | undefined> = ref();

    const left: ComputedRef<number> = computed(() =>
      Math.min(props.modelValue.start.x, props.modelValue.end.x),
    );
    const top: ComputedRef<number> = computed(() =>
      Math.min(props.modelValue.start.y, props.modelValue.end.y),
    );

    const xFlip: ComputedRef<boolean> = computed(
      () => props.modelValue.end.x - left.value > 0,
    );
    const yFlip: ComputedRef<boolean> = computed(
      () => props.modelValue.end.y - top.value > 0,
    );

    const width: ComputedRef<number> = computed(() =>
      xFlip.value
        ? props.modelValue.end.x - left.value
        : props.modelValue.start.x - left.value,
    );
    const height: ComputedRef<number> = computed(() =>
      yFlip.value
        ? props.modelValue.end.y - top.value
        : props.modelValue.start.y - top.value,
    );

    const padding: number = 30;
    const strength: number = 60;

    const d: ComputedRef<string> = computed(() => {
      if (xFlip.value) {
        if (yFlip.value) {
          return `M ${padding} ${padding + 2} C ${padding + strength} ${
            padding + 2
          }, ${width.value + padding - strength} ${
            height.value + padding + 2
          }, ${width.value + padding} ${height.value + padding + 2}`;
        } else {
          return `M ${padding} ${height.value + padding + 2} C ${
            strength + padding
          }  ${height.value + padding + 2}, ${
            width.value + padding - strength
          } ${padding + 2}, ${width.value + padding} ${padding + 2}`;
        }
      } else if (yFlip.value) {
        return `M ${width.value + padding} ${padding + 2} C ${
          width.value + padding - strength
        } ${padding + 2}, ${strength + padding} ${
          height.value + padding + 2
        }, ${padding} ${height.value + padding + 2}`;
      }
      return `M ${width.value + padding} ${height.value + padding + 2} C ${
        width.value + padding - strength
      } ${height.value + padding + 2}, ${strength + padding} ${
        padding + 2
      }, ${padding} ${padding + 2}`;
    });

    const iconX1: ComputedRef<number> = computed(() => {
      if (xFlip.value) {
        if (yFlip.value) {
          return padding - 8;
        } else {
          return padding - 8;
        }
      } else if (yFlip.value) {
        return width.value + padding + -8;
      }
      return width.value + padding + -8;
    });

    const iconY1: ComputedRef<number> = computed(() => {
      if (xFlip.value) {
        if (yFlip.value) {
          return padding - 8 - 2;
        } else {
          return height.value + padding + -8 - 2;
        }
      } else if (yFlip.value) {
        return padding - 8 - 2;
      }
      return height.value + padding + -8 - 2;
    });

    const iconX2: ComputedRef<number> = computed(() => {
      if (xFlip.value) {
        if (yFlip.value) {
          return width.value + padding + -8;
        } else {
          return width.value + padding + -8;
        }
      } else if (yFlip.value) {
        return padding - 8;
      }
      return padding - 8;
    });

    const iconY2: ComputedRef<number> = computed(() => {
      if (xFlip.value) {
        if (yFlip.value) {
          return height.value + padding + -8 - 2;
        } else {
          return padding - 8 - 2;
        }
      } else if (yFlip.value) {
        return height.value + padding + -8 - 2;
      }
      return padding - 8 - 2;
    });

    return {
      connection,
      left,
      top,
      width,
      height,
      d,
      iconX1,
      iconY1,
      iconX2,
      iconY2,
      padding,
    };
  },
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
