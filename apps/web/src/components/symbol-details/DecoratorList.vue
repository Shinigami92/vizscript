<script setup lang="ts">
import { nextTick, ref, useTemplateRef } from 'vue';

/**
 * Decorators of a declaration or input, like UE's specifiers: each one a
 * field (emptied, it goes), and "+ Decorator" for another.
 */
const props = defineProps<{
  decorators: ReadonlyArray<string>;
  editable: boolean;
  /** What they decorate, for the fields' labels (`get`, `input id`). */
  owner: string;
}>();

const emit = defineEmits<{
  /** `index` undefined: a new one; `text` null: remove it. */
  set: [index: number | undefined, text: string | null];
}>();

const adding = ref(false);
const field = useTemplateRef<HTMLInputElement>('field');

async function startAdding(): Promise<void> {
  adding.value = true;
  await nextTick();
  field.value?.focus();
}

function commit(index: number | undefined, event: Event): void {
  const value = (event.target as HTMLInputElement).value.trim();
  if (index === undefined) {
    adding.value = false;
    if (value !== '') {
      emit('set', undefined, value);
    }
  } else if (value !== props.decorators[index]) {
    emit('set', index, value === '' ? null : value);
  }
}

function blurOnEnter(event: KeyboardEvent): void {
  (event.target as HTMLInputElement).blur();
}
</script>

<template>
  <div
    v-if="editable"
    data-ui="decorator-list"
    class="flex min-w-0 flex-col gap-0.5"
  >
    <div
      v-for="(decorator, index) in decorators"
      :key="`${index}:${decorator}`"
      class="flex min-w-0 items-center gap-1"
    >
      <input
        class="input py-0.5 font-mono text-xs"
        :value="decorator"
        :aria-label="`Decorator ${index + 1} of ${owner}`"
        spellcheck="false"
        @keydown.enter.prevent="blurOnEnter"
        @change="commit(index, $event)"
      />
      <button
        type="button"
        class="btn-ghost shrink-0 px-1 text-zinc-500 hover:text-red-400"
        :title="`Remove ${decorator}`"
        :aria-label="`Remove ${decorator}`"
        @click="emit('set', index, null)"
      >
        <span class="i-mdi-close" />
      </button>
    </div>
    <input
      v-if="adding"
      ref="field"
      class="input py-0.5 font-mono text-xs"
      placeholder="@Decorator()"
      :aria-label="`New decorator of ${owner}`"
      spellcheck="false"
      @keydown.enter.prevent="blurOnEnter"
      @keydown.escape.prevent="adding = false"
      @change="commit(undefined, $event)"
      @blur="adding = false"
    />
    <button
      v-else
      type="button"
      data-ui="add-decorator"
      class="btn-ghost self-start px-1 py-0.5 text-xs text-zinc-400"
      :title="`Add a decorator to ${owner}`"
      @click="startAdding"
    >
      <span class="i-mdi-plus" /> Decorator
    </button>
  </div>
  <div v-else class="flex min-w-0 flex-col gap-0.5 font-mono text-zinc-200">
    <span
      v-for="decorator in decorators"
      :key="decorator"
      class="truncate"
      :title="decorator"
      >{{ decorator }}</span
    >
  </div>
</template>
