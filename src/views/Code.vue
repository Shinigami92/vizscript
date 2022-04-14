<script lang="ts">
import type { Ref } from 'vue';
import { defineComponent, ref } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';

export default defineComponent({
  components: {
    Prism,
  },
  setup() {
    const current: Ref<{ fileName: string; sourceText: string }> = ref({
      fileName,
      sourceText,
    });

    return { current };
  },
});
</script>

<template lang="pug">
prism(language="typescript") {{ current.sourceText }}
</template>
