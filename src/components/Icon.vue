<template lang="pug">
span.mdi(:class='iconName', :style='style')
</template>

<script lang="ts">
import type { HTMLAttributes } from '@vue/runtime-dom';
import { defineComponent, Ref, ref } from 'vue';
export default defineComponent({
  name: 'Icon',
  props: {
    size: { type: Number, default: 16 }
  },
  setup(props, { slots }) {
    const iconName: Ref<string | undefined> = ref(slots.default!()[0]?.children as string);
    if (!iconName.value?.startsWith('mdi-')) {
      iconName.value = `mdi-${iconName.value}`;
    }
    const style: HTMLAttributes['style'] = {
      fontSize: `${props.size}px`
    };
    return { iconName, style };
  }
});
</script>
