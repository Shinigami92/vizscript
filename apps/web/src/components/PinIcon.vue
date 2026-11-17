<script setup lang="ts">
import type { Pin } from '@vizscript/core';
import {
  execColor,
  isArrayType,
  isMapType,
  isSetType,
  mapValueType,
  pinColor,
} from '@vizscript/core';
import { computed } from 'vue';
import { useTheme } from '../composables/use-theme';

/**
 * A pin's symbol like on the canvas: exec arrow, value dot, array grid,
 * map list (key column, value rows) or set braces.
 */
const props = defineProps<{
  pin: Pick<Pin, 'kind' | 'type'>;
  size?: number;
}>();

const size = computed(() => props.size ?? 10);
const { scheme } = useTheme();
const color = computed(() => pinColor(props.pin.type, scheme.value));
const isArray = computed(
  () => props.pin.kind === 'data' && isArrayType(props.pin.type)
);
const isMap = computed(
  () => props.pin.kind === 'data' && isMapType(props.pin.type)
);
const isSet = computed(
  () => props.pin.kind === 'data' && isSetType(props.pin.type)
);
// An untyped map is one color, like an untyped array.
const valueColor = computed(() =>
  props.pin.type === 'map'
    ? color.value
    : pinColor(mapValueType(props.pin.type), scheme.value)
);
</script>

<template>
  <span
    v-if="pin.kind === 'exec'"
    class="inline-block shrink-0 rotate-45"
    :style="{
      width: `${size * 0.8}px`,
      height: `${size * 0.8}px`,
      background: execColor(scheme),
    }"
    aria-hidden="true"
  />
  <span
    v-else-if="isArray"
    class="inline-grid shrink-0 grid-cols-3"
    :style="{ width: `${size}px`, height: `${size}px`, gap: '1px' }"
    aria-hidden="true"
  >
    <span v-for="i in 9" :key="i" :style="{ background: color }" />
  </span>
  <span
    v-else-if="isMap"
    class="inline-grid shrink-0"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      gap: '1px',
      gridTemplateColumns: '1fr 2fr',
    }"
    aria-hidden="true"
  >
    <template v-for="i in 3" :key="i">
      <span :style="{ background: color }" />
      <span :style="{ background: valueColor }" />
    </template>
  </span>
  <svg
    v-else-if="isSet"
    class="inline-block shrink-0"
    :width="size"
    :height="size"
    viewBox="0 0 10 10"
    fill="none"
    :stroke="color"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      d="M3.8 0.8Q2 0.8 2 2.8V4Q2 5 0.7 5Q2 5 2 6V7.2Q2 9.2 3.8 9.2M6.2 0.8Q8 0.8 8 2.8V4Q8 5 9.3 5Q8 5 8 6V7.2Q8 9.2 6.2 9.2"
    />
  </svg>
  <span
    v-else
    class="inline-block shrink-0 rounded-full"
    :style="{ width: `${size}px`, height: `${size}px`, background: color }"
    aria-hidden="true"
  />
</template>
