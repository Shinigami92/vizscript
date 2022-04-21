<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizEventConnection } from '@/shared/viz-components/connections/VizEventConnection';
import { isEventConnection } from '@/shared/viz-components/connections/VizEventConnection';
import { computed, ref } from 'vue';

const props = defineProps<{
  modelValue: VizEventConnection;
}>();

const emit = defineEmits({
  'update:modelValue': isEventConnection as EmitType<VizEventConnection>,
});

const modelValue = useVModelValue(props, emit);

console.debug('Unused const', modelValue);

const connection = ref<HTMLDivElement>();

const left = computed(() =>
  Math.min(props.modelValue.start.x, props.modelValue.end.x),
);
const top = computed(() =>
  Math.min(props.modelValue.start.y, props.modelValue.end.y),
);

const xFlip = computed(() => props.modelValue.end.x - left.value > 0);
const yFlip = computed(() => props.modelValue.end.y - top.value > 0);

const width = computed(() =>
  xFlip.value
    ? props.modelValue.end.x - left.value
    : props.modelValue.start.x - left.value,
);
const height = computed(() =>
  yFlip.value
    ? props.modelValue.end.y - top.value
    : props.modelValue.start.y - top.value,
);

const padding = 30;
const strength = 60;

const d = computed(() => {
  if (xFlip.value) {
    if (yFlip.value) {
      return `M ${padding} ${padding + 2} C ${padding + strength} ${
        padding + 2
      }, ${width.value + padding - strength} ${height.value + padding + 2}, ${
        width.value + padding
      } ${height.value + padding + 2}`;
    } else {
      return `M ${padding} ${height.value + padding + 2} C ${
        strength + padding
      }  ${height.value + padding + 2}, ${width.value + padding - strength} ${
        padding + 2
      }, ${width.value + padding} ${padding + 2}`;
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

const iconX1 = computed(() => {
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

const iconY1 = computed(() => {
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

const iconX2 = computed(() => {
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

const iconY2 = computed(() => {
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
</script>

<template lang="pug">
.viz-connection.viz-event-connection.shape(
  ref="connection",
  :style="{ left: `${left - padding}px`, top: `${top - padding}px` }"
)
  svg(:height="height + 4 + padding * 2", :width="width + padding * 2")
    path(:d="d", fill="transparent", stroke="white", stroke-width="4")
  Icon.absolute(:style="{ left: `${iconX1}px`, top: `${iconY1}px` }") mdi-circle
  Icon.absolute(:style="{ left: `${iconX2}px`, top: `${iconY2}px` }") mdi-circle
</template>

<style lang="postcss" scoped>
.viz-connection {
  @apply absolute pointer-events-none;
}

.viz-event-connection.shape {
  @apply text-primary-50;
}
</style>
