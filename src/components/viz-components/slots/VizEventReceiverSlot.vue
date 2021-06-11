<template lang="pug">
icon(v-if="connected", :size="48") mdi-arrow-right-bold
icon(v-else, :size="48") mdi-arrow-right-bold-outline
</template>

<script lang="ts">
import Icon from '@/components/Icon.vue';
import { defineComponent } from 'vue';
export default defineComponent({
  name: 'VizEventReceiverSlot',
  components: { Icon },
  props: { connected: { type: Boolean, required: true } }
});
</script>
