<template lang="pug">
.shape
  .header
    icon(:size='32') mdi-arrow-right-bold-hexagon-outline
    .title Event Start
  .body
    icon(:size='48') mdi-arrow-right-bold-outline
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'EventStart',
  components: { Icon }
});
</script>

<style lang="postcss" scoped>
.shape {
  @apply max-w-64 grid grid-rows-[48px,64px] rounded shadow text-primary-50 bg-background-400;

  .header {
    @apply flex items-center rounded-t bg-red-400;

    .title {
      @apply text-xl text-primary-50;
    }
  }

  .body {
    @apply flex items-center justify-end rounded-b bg-background-400;
  }
}
</style>
