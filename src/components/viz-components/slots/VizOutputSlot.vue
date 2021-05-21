<template lang="pug">
.viz-output-slot.shape
  .title {{ title }}
  icon mdi-circle-outline
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import { defineComponent } from 'vue';
export default defineComponent({
  name: 'VizOutputSlot',
  components: { Icon },
  props: {
    title: { type: String, required: true }
  }
});
</script>

<style lang="postcss" scoped>
.viz-output-slot.shape {
  @apply my-1 px-2 min-w-20 flex items-end;

  .title {
    @apply mr-2 text-base text-primary-50;
  }
}
</style>
