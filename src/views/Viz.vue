<template lang="pug">
div
  .text-3xl.text-primary-400 Viz
  event-start
</template>

<script lang="ts">
import EventStart from '@/components/viz-components/EventStart.vue';
import { defineComponent } from 'vue';

export default defineComponent({
  components: { EventStart }
});
</script>
