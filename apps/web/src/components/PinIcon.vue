<script setup lang="ts">
import type { Pin } from '@vizscript/core';
import { execColor, isArrayType, pinColor } from '@vizscript/core';
import { computed } from 'vue';
import { useTheme } from '../composables/use-theme';

/** A pin's symbol like on the canvas: exec arrow, value dot or array grid. */
const props = defineProps<{ pin: Pin; size?: number }>();

const size = computed(() => props.size ?? 10);
const { scheme } = useTheme();
const color = computed(() => pinColor(props.pin.type, scheme.value));
const isArray = computed(
  () => props.pin.kind === 'data' && isArrayType(props.pin.type)
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
    v-else
    class="inline-block shrink-0 rounded-full"
    :style="{ width: `${size}px`, height: `${size}px`, background: color }"
    aria-hidden="true"
  />
</template>
