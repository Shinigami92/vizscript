<script setup lang="ts">
import { createSourceFile, ScriptTarget } from 'typescript';
import { ref } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';

const current = ref({
  fileName,
  ast: JSON.stringify(
    createSourceFile(fileName, sourceText, ScriptTarget.ESNext, false),
    null,
    2,
  ),
});
</script>

<template lang="pug">
Prism(language="json") {{ current.ast }}
</template>
