<template>
  <div class="code">
    <prism language="typescript">{{ current.sourceText }}</prism>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import Prism from 'vue-prism-component';
import { fileName, sourceText } from './greeter-example';

export default defineComponent({
  components: {
    Prism
  },
  data: () => ({
    current: { fileName, sourceText }
  })
});
</script>
