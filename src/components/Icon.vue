<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { ref, useSlots } from 'vue';

const props = withDefaults(defineProps<{ size?: number }>(), {
  size: 16,
});

const slots = useSlots();

const iconName = ref(slots.default!()[0]?.children as string | undefined);

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
