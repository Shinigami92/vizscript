<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const isSideOpen = ref(false);

function afterEnter(el: HTMLDivElement): void {
  el.classList.add('w-50');
}
</script>

<template lang="pug">
aside.flex
  .w-14.bg-background-400.flex-none.flex.flex-col.items-center.justify-between
    button
      Icon.mx-1(:size="40", @click="isSideOpen = !isSideOpen") mdi-menu

    a(href="https://github.com/Shinigami92/vizscript", target="_blank")
      Icon.mx-1(:size="48") mdi-github

  Transition(
    enter-active-class="duration-300 ease-out",
    enter-from-class="w-0",
    enter-to-class="w-50",
    leave-active-class="duration-200 ease-in",
    leave-from-class="w-50",
    leave-to-class="w-0",
    @after-enter="afterEnter"
  )
    .bg-background-500(v-if="isSideOpen")
      span.text-primary-50 Explorer
      div
</template>
