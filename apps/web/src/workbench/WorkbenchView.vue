<script setup lang="ts">
import type { ViewId } from '@vizscript/workbench';
import { computed, inject, onBeforeUnmount } from 'vue';
import { WORKBENCH } from './context';

const props = defineProps<{ id: ViewId }>();

const context = inject(WORKBENCH);
if (!context) {
  throw new Error('WorkbenchView must be used inside a Workbench');
}

const unregister = context.register(props.id);
onBeforeUnmount(unregister);

const to = computed(() => context.target(props.id));
</script>

<template>
  <Teleport v-if="context.ready.value && to" :to="to">
    <div class="h-full w-full min-h-0 min-w-0">
      <slot />
    </div>
  </Teleport>
</template>
