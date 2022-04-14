<script lang="ts" setup>
import type { Ref } from 'vue';
import { ref } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';

const current: Ref<{ fileName: string; sourceText: string }> = ref({
  fileName,
  sourceText,
});
</script>

<template lang="pug">
Prism(language="typescript") {{ current.sourceText }}
</template>
