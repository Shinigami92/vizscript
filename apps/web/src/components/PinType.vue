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
const label = computed(() =>
  shown.value.kind === 'exec' ? 'exec' : shown.value.type || 'any'
);
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
