<script lang="ts">
import Icon from '@/components/Icon.vue';
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'VizInputSlot',
  components: { Icon },
  props: {
    title: { type: String, required: true },
    connected: { type: Boolean, required: true },
  },
});
</script>

<template lang="pug">
.viz-input-slot.shape
  Icon(v-if="connected") mdi-circle
  Icon(v-else) mdi-circle-outline
  .title {{ title }}
</template>

<style lang="postcss" scoped>
.viz-input-slot.shape {
  @apply my-1 px-2 min-w-20 flex;

  .title {
    @apply ml-2 text-base text-primary-50;
  }
}
</style>
