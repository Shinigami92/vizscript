<script setup lang="ts">
import type { DataType, Pin } from '@vizscript/core';
import { computed } from 'vue';
import PinIcon from './PinIcon.vue';

/**
 * A type at the end of a Details row, like UE: the pin's symbol in its
 * color, the type name on hover. A variable's value passes its `type`.
 */
const props = defineProps<{ pin?: Pin; type?: DataType }>();

const shown = computed<Pick<Pin, 'kind' | 'type'>>(
  () => props.pin ?? { kind: 'data', type: props.type ?? 'any' }
);
const label = computed(() => {
  if (shown.value.kind === 'exec') {
    return 'exec';
  }

  const type = shown.value.type || 'any';
  // An untyped value shown with the type of where it goes.
  return props.pin?.usedAs ? `any, used as ${type}` : type;
});
</script>

<template>
  <span
    class="flex w-3 shrink-0 justify-center"
    role="img"
    :title="label"
    :aria-label="`Type ${label}`"
    data-ui="pin-type"
  >
    <PinIcon :pin="shown" :size="9" />
  </span>
</template>
