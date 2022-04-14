<script lang="ts" setup>
import { ref } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';

const current = ref({
  fileName,
  sourceText,
});
</script>

<template lang="pug">
Prism(language="typescript") {{ current.sourceText }}
</template>
