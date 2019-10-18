<template>
  <div class="ast">
    <code>
      <pre>{{ current.ast }}</pre>
    </code>
  </div>
</template>

<script lang="ts">
import ts from 'typescript';
import Vue from 'vue';
import { fileName, sourceText } from './greeter-example';

export default Vue.extend({
  data: () => ({
    current: {
      fileName,
      ast: JSON.stringify(ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, false), null, 2)
    }
  })
});
</script>
