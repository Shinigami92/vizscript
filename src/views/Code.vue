<template lang="pug">
prism(language="typescript") {{ current.sourceText }}
</template>

<script lang="ts">
import { defineComponent, ref, Ref } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';

export default defineComponent({
  components: {
    Prism
  },
  setup() {
    const current: Ref<{ fileName: string; sourceText: string }> = ref({ fileName, sourceText });

    return { current };
  }
});
</script>
