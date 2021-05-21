<template lang="pug">
header.flex.justify-end.items-center.bg-background-400
  span.mdi.mdi-math-integral.text-4xl.text-primary-400(@click='navigateTo("code")')
  span.mdi.mdi-code-braces.text-4xl.text-primary-400(@click='navigateTo("viz")')
  span.mdi.mdi-pine-tree.text-4xl.text-primary-400(@click='navigateTo("ast")')
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { RouteLocationRaw, Router, useRouter } from 'vue-router';
export default defineComponent({
  setup() {
    const router: Router = useRouter();
    const navigateTo: (location: RouteLocationRaw) => void = (location) => router.push(location);
    return { navigateTo };
  }
});
</script>
