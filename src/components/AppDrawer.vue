<script lang="ts">
import Icon from '@/components/Icon.vue';
import { defineComponent } from 'vue';

export default defineComponent({
  components: { Icon },
});
</script>

<template lang="pug">
aside.grid(class="grid-cols-[56px,1fr]")
  .bg-background-400.flex.items-end
    a(href="https://github.com/Shinigami92/vizscript", target="_blank")
      Icon.mx-1(:size="48") github
  .bg-background-500
    span.text-primary-50 Explorer
    div
</template>
