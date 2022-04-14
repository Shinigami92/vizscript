<script lang="ts" setup>
import Icon from '@/components/Icon.vue';
import type { RouteLocationRaw, Router } from 'vue-router';
import { useRouter } from 'vue-router';

const router: Router = useRouter();

const navigateTo: (location: RouteLocationRaw) => void = (location) =>
  router.push(location);
</script>

<template lang="pug">
header.flex.justify-end.items-center.bg-background-400
  Icon.text-primary-400(:size="32", @click="navigateTo('code')") mdi-code-braces
  Icon.text-primary-400(:size="32", @click="navigateTo('viz')") mdi-math-integral
  Icon.text-primary-400(:size="32", @click="navigateTo('ast')") mdi-pine-tree
</template>
