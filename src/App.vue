<script setup lang="ts">
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
.h-screen.flex
  AppDrawer.flex-initial
  .flex-1.flex.flex-col.overflow-hidden
    AppBar.flex-shrink-0
    AppMainContent.flex-shrink
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
