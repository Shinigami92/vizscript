<script lang="ts">
import Icon from '@/components/Icon.vue';
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'VizEventReceiverSlot',
  components: { Icon },
  props: { connected: { type: Boolean, required: true } },
});
</script>

<template lang="pug">
Icon(v-if="connected", :size="48") mdi-arrow-right-bold
Icon(v-else, :size="48") mdi-arrow-right-bold-outline
</template>
