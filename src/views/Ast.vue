<template lang="pug">
prism(language="json") {{ current.ast }}
</template>

<script lang="ts">
import { createSourceFile, ScriptTarget } from 'typescript';
import { defineComponent, Ref, ref } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';
export default defineComponent({
  components: {
    Prism
  },
  setup() {
    const current: Ref<{ fileName: string; ast: string }> = ref({
      fileName,
      ast: JSON.stringify(createSourceFile(fileName, sourceText, ScriptTarget.ESNext, false), null, 2)
    });
    return { current };
  }
});
</script>
