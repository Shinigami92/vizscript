<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useToasts } from '../composables/use-toasts';
import type { LocalProject, RememberedFolder } from '../local/projects';
import {
  canAccessFolders,
  forgetFolder,
  pickFolder,
  projectFromFiles,
  rememberedFolders,
} from '../local/projects';
import { timeAgo } from '../stores/recent';

const router = useRouter();
const { show } = useToasts();
const folders = ref<RememberedFolder[]>([]);
const busy = ref(false);
const input = useTemplateRef<HTMLInputElement>('input');

async function load(): Promise<void> {
  folders.value = canAccessFolders
    ? await rememberedFolders().catch(() => [])
    : [];
}

onMounted(load);

function openProject(project: LocalProject): void {
  void router.push({
    name: 'local',
    params: { id: project.id, path: [] },
  });
}

async function open(): Promise<void> {
  if (!canAccessFolders) {
    input.value?.click();
    return;
  }

  busy.value = true;
  try {
    openProject(await pickFolder());
  } catch (error) {
    // Closing the picker is not an error.
    if ((error as Error).name !== 'AbortError') {
      show(`Opening the folder failed: ${(error as Error).message}`, 'error');
    }
  } finally {
    busy.value = false;
  }
}

async function onFiles(event: Event): Promise<void> {
  const files = [...((event.target as HTMLInputElement).files ?? [])];
  if (files.length > 0) {
    openProject(await projectFromFiles(files));
  }
}

async function forget(folder: RememberedFolder): Promise<void> {
  await forgetFolder(folder.id);
  await load();
}
</script>

<template>
  <div
    data-ui="local-folders-page"
    class="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8"
  >
    <div>
      <h1 class="text-xl font-semibold">Local folders</h1>
      <p class="text-sm text-zinc-400">
        Open a project folder from this computer. Its files stay on your
        computer: they are read by the browser and never uploaded.
        <template v-if="canAccessFolders">
          Changes are saved back into the folder.
        </template>
      </p>
    </div>

    <div>
      <button type="button" class="btn-primary" :disabled="busy" @click="open">
        <span class="i-mdi-folder-open-outline" /> Open folder…
      </button>
      <input
        ref="input"
        type="file"
        class="hidden"
        webkitdirectory
        @change="onFiles"
      />
    </div>

    <p
      v-if="!canAccessFolders"
      class="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-400"
    >
      <span class="i-mdi-information-outline mr-1 align-[-2px]" />
      This browser can only read folders: changes can't be saved and the folder
      has to be opened again after a reload. Chrome and Edge can save changes
      and remember folders.
    </p>

    <section v-if="folders.length > 0" aria-labelledby="folders-title">
      <h2
        id="folders-title"
        class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500"
      >
        <span class="i-mdi-history text-sm" /> Recently opened
      </h2>
      <ul class="grid gap-2 sm:grid-cols-2">
        <li v-for="folder in folders" :key="folder.id" class="group relative">
          <RouterLink
            :to="{ name: 'local', params: { id: folder.id, path: [] } }"
            class="card flex h-full items-center gap-2 px-3 py-2.5 pr-9 hover:border-zinc-600 hover:bg-zinc-800/60 focus-visible:border-amber-500 focus-visible:outline-none"
          >
            <span class="i-mdi-folder-outline shrink-0 text-amber-400/70" />
            <span class="min-w-0 flex-1 truncate font-medium text-zinc-100">{{
              folder.name
            }}</span>
            <span class="shrink-0 text-xs text-zinc-500">{{
              timeAgo(new Date(folder.openedAt).toISOString())
            }}</span>
          </RouterLink>
          <button
            type="button"
            class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-zinc-100 focus:opacity-100 group-hover:opacity-100"
            :aria-label="`Remove ${folder.name} from recent`"
            title="Remove from recent"
            @click="forget(folder)"
          >
            <span class="i-mdi-close block text-sm" />
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
