<script lang="ts">
import Icon from '@/components/Icon.vue';
import { defineComponent } from 'vue';
import type { RouteLocationRaw, Router } from 'vue-router';
import { useRouter } from 'vue-router';

export default defineComponent({
  components: { Icon },
  setup() {
    const router: Router = useRouter();

    const navigateTo: (location: RouteLocationRaw) => void = (location) =>
      router.push(location);

    return { navigateTo };
  },
});
</script>

<template lang="pug">
header.flex.justify-end.items-center.bg-background-400
  icon.text-primary-400(:size="32", @click="navigateTo('code')") mdi-code-braces
  icon.text-primary-400(:size="32", @click="navigateTo('viz')") mdi-math-integral
  icon.text-primary-400(:size="32", @click="navigateTo('ast')") mdi-pine-tree
</template>
