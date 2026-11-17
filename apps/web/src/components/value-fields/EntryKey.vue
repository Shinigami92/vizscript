<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

/**
 * The key of an object entry in Details: its name, or a field while it is
 * renamed (or typed for a new entry). Enter or leaving the field commits.
 */
const props = defineProps<{
  name: string;
  editing: boolean;
  editable: boolean;
  /** Accessible name of the field. */
  label: string;
}>();

const emit = defineEmits<{
  /** Double-click: rename. */
  start: [];
  commit: [key: string];
  cancel: [];
}>();

const draft = ref(props.name);
const input = ref<HTMLInputElement | null>(null);
let done = false;

watch(
  () => props.editing,
  async (editing) => {
    if (editing) {
      draft.value = props.name;
      done = false;
      await nextTick();
      input.value?.focus();
      input.value?.select();
    }
  },
  { immediate: true }
);

function commit(): void {
  if (!done) {
    done = true;
    emit('commit', draft.value.trim());
  }
}

function cancel(): void {
  done = true;
  emit('cancel');
}
</script>

<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    class="input w-full min-w-0 py-0.5 font-mono text-xs"
    placeholder="key"
    :aria-label="label"
    spellcheck="false"
    @keydown.enter.prevent="commit"
    @keydown.escape.prevent="cancel"
    @blur="commit"
  />
  <span
    v-else
    class="block truncate font-mono text-zinc-500"
    :title="editable ? `${name}\nDouble-click to rename` : name"
    @dblclick="editable && emit('start')"
    >{{ name }}</span
  >
</template>
