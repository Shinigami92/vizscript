<script setup lang="ts">
import type { LanguageVersion } from '@vizscript/core';
import { computed } from 'vue';
import { languageName } from '../../graph/languages';

const props = defineProps<{
  path: string;
  version: LanguageVersion | null;
  /** Names of the files a version is read from (`pyproject.toml`). */
  versionFiles: ReadonlyArray<string>;
  /** The repository's files are known (not the playground). */
  hasProject: boolean;
}>();

const emit = defineEmits<{ open: [path: string] }>();

const name = computed(() => languageName(props.path));

const title = computed(() => {
  const version = props.version;
  if (version) {
    return `${name.value} ${version.text}\n${version.detail} (${version.path})\nClick to open ${version.path}`;
  }

  if (!props.hasProject) {
    return `${name.value}\nNo project files here, so no version is known`;
  }

  return props.versionFiles.length > 0
    ? `${name.value}\nNo version found in ${props.versionFiles.join(', ')}`
    : `${name.value}`;
});
</script>

<template>
  <!-- After the file items, like VS Code's language mode. -->
  <Teleport v-if="name" defer to="#workbench-status">
    <button
      v-if="version"
      data-ui="status-language"
      type="button"
      class="order-last flex h-full shrink-0 items-center gap-1 rounded-sm px-1.5 hover:bg-zinc-800 hover:text-zinc-100"
      :title="title"
      @click="emit('open', version.path)"
    >
      <span class="i-mdi-code-braces" />
      {{ name }}
      <span class="text-zinc-500">{{ version.text }}</span>
    </button>
    <span
      v-else
      data-ui="status-language"
      class="order-last flex h-full shrink-0 items-center gap-1 px-1.5"
      :title="title"
    >
      <span class="i-mdi-code-braces" />
      {{ name }}
    </span>
  </Teleport>
</template>
