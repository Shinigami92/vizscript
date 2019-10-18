<template>
  <div class="code">
    <code>
      <pre>{{ current.sourceText }}</pre>
    </code>
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
