<script lang="ts" setup>
import AppBar from '@/components/AppBar.vue';
import AppDrawer from '@/components/AppDrawer.vue';
import AppMainContent from '@/components/AppMainContent.vue';

function preventMotion(event: Event): void {
  window.scrollTo(0, 0);
  event.preventDefault();
  event.stopPropagation();
}

// https://stackoverflow.com/a/35171163/6897682
window.addEventListener('scroll', preventMotion, false);
window.addEventListener('touchmove', preventMotion, false);
</script>

<template lang="pug">
.h-screen.grid(class="grid-cols-[320px,1fr]")
  AppDrawer
  .grid.max-h-screen(class="grid-rows-[56px,1fr]")
    AppBar
    AppMainContent
</template>

<style lang="scss">
html {
  overflow: hidden;
}

body {
  overflow: hidden;
  position: relative;
  margin: 0;
  padding: 0;
}

pre[class*='language-'] {
  background: transparent;
  margin: 0;
}
</style>
