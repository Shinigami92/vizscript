<script lang="ts" setup>
import { createSourceFile, ScriptTarget } from 'typescript';
import type { Ref } from 'vue';
import { ref } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';

const current: Ref<{ fileName: string; ast: string }> = ref({
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
