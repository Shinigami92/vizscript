<script setup lang="ts">
import type { TreeEntry } from '@vizscript/api-contract';
import { useDebounceFn, useEventListener } from '@vueuse/core';
import { computed, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import FileTree from '../components/FileTree.vue';
import ScriptWorkspace from '../components/ScriptWorkspace.vue';
import { useToasts } from '../composables/use-toasts';
import { localLayoutStore } from '../graph/layout-store';
import { shortcut } from '../graph/source';
import type { LocalProject, OpenResult } from '../local/projects';
import { openProject } from '../local/projects';
import { useWorkbenchStore } from '../stores/workbench';
import LayoutMenu from '../workbench/LayoutMenu.vue';
import Workbench from '../workbench/Workbench.vue';
import WorkbenchView from '../workbench/WorkbenchView.vue';

const route = useRoute();
const router = useRouter();
const { show } = useToasts();
const workbench = useWorkbenchStore();

const id = computed(() => String(route.params.id));
const path = computed(() => {
  const value = route.params.path;
  return Array.isArray(value) ? value.join('/') : (value ?? '');
});

const opening = shallowRef<OpenResult | null>(null);
const project = shallowRef<LocalProject | null>(null);
const entries = shallowRef<TreeEntry[] | null>(null);
const loadingTree = ref(false);
/** Content of the open file on disk (`null` while loading). */
const saved = ref<string | null>(null);
const text = ref('');
const loadingFile = ref(false);
const fileError = ref<string | null>(null);
const saving = ref(false);
/** Bumped to remount the workspace when the file changed on disk. */
const version = ref(0);

const isFile = computed(
  () =>
    path.value !== '' &&
    entries.value?.some((e) => e.path === path.value && e.type === 'file') ===
      true
);
const files = computed(
  () =>
    new Set(entries.value?.filter((e) => e.type === 'file').map((e) => e.path))
);
const dirty = computed(
  () => saved.value !== null && text.value !== saved.value
);
const draftKey = computed(
  () => `vizscript:draft:local/${id.value}:${path.value}`
);
const layoutStore = computed(() =>
  isFile.value ? localLayoutStore(`local/${id.value}:${path.value}`) : null
);

async function loadTree(): Promise<void> {
  if (!project.value) {
    return;
  }

  loadingTree.value = true;
  try {
    const listing = await project.value.list();
    entries.value = listing.entries;
    if (listing.truncated) {
      show('This folder is large; the file list is truncated.');
    }
  } catch (error) {
    show(`Reading the folder failed: ${(error as Error).message}`, 'error');
  } finally {
    loadingTree.value = false;
  }
}

async function open(): Promise<void> {
  project.value = null;
  entries.value = null;
  opening.value = await openProject(id.value);
  if (opening.value.status === 'ready') {
    project.value = opening.value.project;
    await loadTree();
  }
}

async function grant(): Promise<void> {
  if (opening.value?.status !== 'permission') {
    return;
  }

  try {
    project.value = await opening.value.grant();
    opening.value = { status: 'ready', project: project.value };
    await loadTree();
  } catch (error) {
    show((error as Error).message, 'error');
  }
}

async function loadFile(): Promise<void> {
  saved.value = null;
  fileError.value = null;
  if (!project.value || !isFile.value) {
    return;
  }

  loadingFile.value = true;
  try {
    const content = await project.value.read(path.value);
    let initial = content;
    try {
      const draft = JSON.parse(
        localStorage.getItem(draftKey.value) ?? 'null'
      ) as { base: string; text: string } | null;
      if (draft?.base === content && draft.text !== content) {
        initial = draft.text;
        show('Restored your unsaved changes for this file.');
      }
    } catch {
      // ignore broken drafts
    }

    text.value = initial;
    saved.value = content;
  } catch (error) {
    fileError.value = (error as Error).message;
  } finally {
    loadingFile.value = false;
  }
}

watch(id, open, { immediate: true });
watch([entries, path], loadFile, { immediate: true });

const saveDraft = useDebounceFn(() => {
  // Read-only folders are gone after a reload, so their drafts would be too.
  if (saved.value === null || !project.value?.canWrite) {
    return;
  }

  try {
    if (dirty.value) {
      localStorage.setItem(
        draftKey.value,
        JSON.stringify({ base: saved.value, text: text.value })
      );
    } else {
      localStorage.removeItem(draftKey.value);
    }
  } catch {
    // storage unavailable
  }
}, 500);

watch(text, saveDraft);

async function save(): Promise<void> {
  if (!project.value || !dirty.value || saving.value) {
    return;
  }

  if (!project.value.canWrite) {
    show('This browser can only read folders. Use Chrome or Edge to save.');
    return;
  }

  saving.value = true;
  const content = text.value;
  try {
    await project.value.write(path.value, content);
    saved.value = content;
    localStorage.removeItem(draftKey.value);
  } catch (error) {
    show(`Saving failed: ${(error as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

function discard(): void {
  if (saved.value !== null) {
    text.value = saved.value;
    localStorage.removeItem(draftKey.value);
  }
}

// Ctrl/Cmd+S saves, also while typing in the editor.
useEventListener(
  window,
  'keydown',
  (event: KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 's'
    ) {
      event.preventDefault();
      void save();
    }
  },
  { capture: true }
);

// Pick up changes made outside (e.g. in another editor) when coming back,
// unless there are unsaved changes here.
useEventListener(window, 'focus', async () => {
  if (!project.value || !isFile.value || dirty.value || saving.value) {
    return;
  }

  try {
    const content = await project.value.read(path.value);
    if (content !== saved.value) {
      text.value = content;
      saved.value = content;
      version.value++;
    }
  } catch {
    // the file was removed or renamed; the tree refresh shows it
  }
});

/** Opens a file, optionally at the definition of `symbol`. */
function selectFile(next: string, symbol?: string): void {
  workbench.mobileDrawer = false;
  void router.push({
    name: 'local',
    params: { id: id.value, path: next.split('/') },
    query: symbol ? { symbol } : {},
  });
}
</script>

<template>
  <Workbench>
    <WorkbenchView id="explorer">
      <div class="flex h-full min-h-0 flex-col">
        <div
          class="flex shrink-0 items-center gap-2 border-b border-zinc-800 py-1.5 pr-1 pl-3"
        >
          <span class="i-mdi-folder-outline shrink-0 text-amber-400/70" />
          <span class="min-w-0 flex-1 truncate text-sm text-zinc-200">{{
            project?.name ?? ''
          }}</span>
          <button
            type="button"
            class="btn-ghost px-2"
            title="Refresh file list"
            aria-label="Refresh file list"
            :disabled="!project || loadingTree"
            @click="loadTree"
          >
            <span class="i-mdi-refresh" />
          </button>
        </div>
        <div v-if="loadingTree && !entries" class="p-4 text-sm text-zinc-500">
          <span class="i-mdi-loading animate-spin" /> Loading…
        </div>
        <FileTree
          v-else-if="entries"
          :entries="entries"
          :selected-path="path || null"
          @select="selectFile"
        />
      </div>
    </WorkbenchView>

    <ScriptWorkspace
      v-if="project && isFile && saved !== null"
      :key="`${id}:${path}:${version}`"
      v-model:text="text"
      :path="path"
      :layout-store="layoutStore"
      :state-key="`local/${id}:${path}`"
      :files="files"
      hide-share
      @open="selectFile"
    >
      <template #toolbar>
        <button
          type="button"
          class="btn-ghost px-2"
          title="Explorer"
          aria-label="Toggle explorer"
          :aria-pressed="workbench.isVisible('explorer')"
          @click="workbench.toggle('explorer')"
        >
          <span class="i-mdi-file-tree-outline" />
        </button>
        <span
          class="min-w-0 truncate font-mono text-xs text-zinc-300"
          :title="`${project.name}/${path}`"
          >{{ path }}</span
        >
        <template v-if="dirty">
          <span
            class="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300"
            >modified</span
          >
          <button
            v-if="project.canWrite"
            type="button"
            class="btn-ghost shrink-0 px-2 text-xs"
            :title="`Save to disk (${shortcut('S')})`"
            :disabled="saving"
            @click="save"
          >
            <span class="i-mdi-content-save-outline" /><span
              class="hidden lg:inline"
              >Save</span
            >
          </button>
          <button
            type="button"
            class="btn-ghost shrink-0 px-2 text-xs"
            title="Discard changes"
            @click="discard"
          >
            <span class="i-mdi-undo-variant" /><span class="hidden lg:inline"
              >Discard</span
            >
          </button>
        </template>
      </template>
    </ScriptWorkspace>

    <template v-else>
      <div
        class="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 px-2"
      >
        <button
          type="button"
          class="btn-ghost px-2"
          title="Explorer"
          aria-label="Toggle explorer"
          :aria-pressed="workbench.isVisible('explorer')"
          @click="workbench.toggle('explorer')"
        >
          <span class="i-mdi-file-tree-outline" />
        </button>
        <span class="truncate text-sm text-zinc-400">{{
          project?.name ?? ''
        }}</span>
        <div class="ml-auto">
          <LayoutMenu />
        </div>
      </div>
      <WorkbenchView id="code">
        <div
          class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-zinc-500"
        >
          <template v-if="opening?.status === 'permission'">
            <span>
              The browser needs your permission to open
              <span class="text-zinc-300">{{ opening.name }}</span> again.
            </span>
            <button type="button" class="btn-primary" @click="grant">
              <span class="i-mdi-folder-open-outline" /> Open
              {{ opening.name }}
            </button>
          </template>
          <template v-else-if="opening?.status === 'missing'">
            <span
              >This folder isn't open anymore. Folders opened without saving
              support have to be opened again after a reload.</span
            >
            <RouterLink to="/local" class="btn-primary">
              <span class="i-mdi-folder-open-outline" /> Open a folder
            </RouterLink>
          </template>
          <span v-else-if="!opening || loadingFile || loadingTree"
            ><span class="i-mdi-loading animate-spin" /> Loading…</span
          >
          <span v-else-if="fileError" class="text-red-300">{{
            fileError
          }}</span>
          <span v-else>
            Select a script file to view it as code and as a node graph.
            <br />
            Files marked with
            <span class="i-mdi-sitemap-outline text-amber-400/70" /> can be
            visualized.
          </span>
        </div>
      </WorkbenchView>
    </template>
  </Workbench>
</template>
