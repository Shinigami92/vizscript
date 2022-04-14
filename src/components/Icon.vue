<script lang="ts" setup>
import type { HTMLAttributes, Ref } from 'vue';
import { ref, useSlots } from 'vue';

const props = withDefaults(
  defineProps<{
    size: number;
  }>(),
  {
    size: 16,
  },
);

const slots = useSlots();

const iconName: Ref<string | undefined> = ref(
  slots.default!()[0]?.children as string,
);

if (!iconName.value?.startsWith('mdi-')) {
  iconName.value = `mdi-${iconName.value!}`;
}

const style: HTMLAttributes['style'] = {
  fontSize: `${props.size}px`,
};
</script>

<template lang="pug">
span.icon.mdi(:class="iconName", :style="style")
</template>
