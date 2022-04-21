<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import VizNode from '@/components/viz-components/nodes/VizNode.vue';
import VizEventEmitterSlot from '@/components/viz-components/slots/VizEventEmitterSlot.vue';
import { useVModelValue } from '@/composables/useVModelValue';
import type { EmitType } from '@/shared/utilities/vue';
import type { VizEventStartNode } from '@/shared/viz-components/nodes/VizEventStartNode';
import { isEventStartNode } from '@/shared/viz-components/nodes/VizEventStartNode';
import { computed } from 'vue';

const props = defineProps<{
  modelValue: VizEventStartNode;
}>();

const emit = defineEmits({
  'update:modelValue': isEventStartNode as EmitType<VizEventStartNode>,
});

const modelValue = useVModelValue(props, emit);

const connected = computed(() => props.modelValue.connected);
</script>

<template lang="pug">
VizNode.viz-event-start.shape(v-model="modelValue")
  template(#header)
    .header
      Icon(:size="32") mdi-arrow-right-bold-hexagon-outline
      .title Event Start
  template(#default)
    .body(v-if="modelValue.model")
      VizEventEmitterSlot(
        :connected="connected",
        :node-id="modelValue.model?.id"
      )
</template>

<style lang="postcss" scoped>
.viz-event-start.shape {
  @apply w-48;
  @apply grid grid-rows-[48px,1fr];
  @apply text-primary-50;

  .header {
    @apply flex items-center;
    @apply rounded-t;
    @apply bg-red-400 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;

    .icon {
      @apply mx-2;
    }

    .title {
      @apply text-xl;
    }
  }

  .body {
    @apply flex items-center justify-end;
    @apply rounded-b;
    @apply bg-background-400 bg-opacity-85;
    @apply backdrop-filter backdrop-blur-1;
  }
}
</style>
