<template lang="pug">
.h-screen.grid(class='grid-cols-[320px,1fr]')
  AppDrawer
  .grid.max-h-screen(class='grid-rows-[56px,1fr]')
    AppBar
    AppMainContent
</template>

<script lang="ts">
import AppBar from '@/components/AppBar.vue';
import AppDrawer from '@/components/AppDrawer.vue';
import AppMainContent from '@/components/AppMainContent.vue';
import { defineComponent } from 'vue';

export default defineComponent({
  components: { AppDrawer, AppBar, AppMainContent }
});
</script>

<style lang="scss">
pre[class*='language-'] {
  background: transparent;
  margin: 0;
}
</style>
