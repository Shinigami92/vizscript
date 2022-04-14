<script lang="ts" setup>
import Icon from '@/components/Icon.vue';
import type { VizCurrentConnectionModel } from '@/shared/models/connections/VizCurrentConnectionModel';
import type {
  PositionModel,
  RefPositionModel,
} from '@/shared/models/PositionModel';
import { computed, ref } from 'vue';

const props = defineProps<{
  currentConnection: VizCurrentConnectionModel;
  pointerPosition: RefPositionModel;
}>();

const startPosition = computed<PositionModel>(() => ({
  x: props.currentConnection.startPosition.x - 320,
  y: props.currentConnection.startPosition.y - 56,
}));

const connection = ref<HTMLDivElement>();

const left = computed(() =>
  Math.min(startPosition.value.x, props.pointerPosition.x.value),
);
const top = computed(() =>
  Math.min(startPosition.value.y, props.pointerPosition.y.value),
);

const xFlip = computed(() => props.pointerPosition.x.value - left.value > 0);
const yFlip = computed(() => props.pointerPosition.y.value - top.value > 0);

const width = computed(() =>
  xFlip.value
    ? props.pointerPosition.x.value - left.value
    : startPosition.value.x - left.value,
);
const height = computed(() =>
  yFlip.value
    ? props.pointerPosition.y.value - top.value
    : startPosition.value.y - top.value,
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
.viz-connection.viz-current-connection.shape(
  ref="connection",
  :style="{ left: `${left - padding}px`, top: `${top - padding}px` }"
)
  svg(:width="width + padding * 2", :height="height + 4 + padding * 2")
    path(stroke="white", stroke-width="4", fill="transparent", :d="d")
  Icon.absolute(:style="{ left: `${iconX1}px`, top: `${iconY1}px` }") mdi-circle
  Icon.absolute(:style="{ left: `${iconX2}px`, top: `${iconY2}px` }") mdi-circle
</template>

<style lang="postcss" scoped>
.viz-connection {
  @apply absolute pointer-events-none;
}

.viz-current-connection.shape {
  @apply text-primary-50;
}
</style>
