<template>
  <div class="code">
    <pre v-highlightjs="current.sourceText"><code class="typescript"></code></pre>
  </div>
</template>

<script lang="ts">
import Vue from 'vue';
import { fileName, sourceText } from './greeter-example';

export default Vue.extend({
  data: () => ({
    current: { fileName, sourceText }
  })
});
</script>
