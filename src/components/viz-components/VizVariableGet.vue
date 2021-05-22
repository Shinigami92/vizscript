<template lang="pug">
.viz-function.shape(
  :style='{ left: `${modelValue.x + dx}px`, top: `${modelValue.y + dy}px` }',
  @mousedown='onMousedown',
  @mousemove='onMousemove',
  @mouseup='onMouseup'
)
  .body
    .outputs
      viz-output-slot(:title='modelValue.name')
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import VizOutputSlot from '@/components/viz-components/slots/VizOutputSlot.vue';
import { usePositionable, UsePositionable } from '@/composables/usePositionable';
import type { EmitType } from '@/shared/utilities/vue';
import { isVizVariableGetModel, VizVariableGetModel } from '@/shared/VizVariableGetModel';
import { defineComponent, PropType } from 'vue';
export default defineComponent({
  name: 'VizVariableGet',
  components: { Icon, VizOutputSlot },
  props: { modelValue: { type: Object as PropType<VizVariableGetModel>, required: true } },
  emits: { 'update:modelValue': isVizVariableGetModel as EmitType<VizVariableGetModel> },
  setup(props, { emit }) {
    const positionable: UsePositionable<VizVariableGetModel> = usePositionable(props, emit);
    return { ...positionable };
  }
});
</script>

<style lang="postcss" scoped>
.viz-function.shape {
  @apply absolute min-w-32 rounded shadow text-primary-50 bg-background-400;

  .body {
    @apply rounded;

    .outputs {
      @apply ml-4 flex flex-col items-end;
    }
  }
}
</style>
