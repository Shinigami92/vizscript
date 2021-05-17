<template>
  <div class="ast">
    <prism language="json">{{ current.ast }}</prism>
  </div>
</template>

<script lang="ts">
import ts from 'typescript';
import Prism from 'vue-prism-component';
import { defineComponent } from 'vue';
import { fileName, sourceText } from './greeter-example';

export default defineComponent({
  components: {
    Prism
  },
  data: () => ({
    current: {
      fileName,
      ast: JSON.stringify(ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, false), null, 2)
    }
  })
});
</script>
