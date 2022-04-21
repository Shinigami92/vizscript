<script setup lang="ts">
import Icon from '@/components/Icon.vue';

defineProps<{
  connected: boolean;
}>();
</script>

<template lang="pug">
Icon(v-if="connected", :size="48") mdi-arrow-right-bold
Icon(v-else, :size="48") mdi-arrow-right-bold-outline
</template>
