<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import type { Router } from 'vue-router';
import { useRouter } from 'vue-router';

const $router: Router = useRouter();
</script>

<template lang="pug">
header.flex.justify-end.items-center.bg-background-400
  Icon.text-primary-400(:size="32", @click="$router.push('code')") mdi-code-braces
  Icon.text-primary-400(:size="32", @click="$router.push('viz')") mdi-math-integral
  Icon.text-primary-400(:size="32", @click="$router.push('ast')") mdi-pine-tree
</template>
