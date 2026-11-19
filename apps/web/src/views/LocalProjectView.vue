<script setup lang="ts">
import type { TreeEntry } from '@vizscript/api-contract';
import { useEventListener } from '@vueuse/core';
import { computed, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import FileTabs from '../components/FileTabs.vue';
import FileTree from '../components/FileTree.vue';
import OutdatedDraftNotice from '../components/OutdatedDraftNotice.vue';
import ScriptWorkspace from '../components/ScriptWorkspace.vue';
import { useFileSession } from '../composables/use-file-session';
import { useTabActions } from '../composables/use-tab-actions';
import { useToasts } from '../composables/use-toasts';
import { localLayoutStore } from '../graph/layout-store';
import { shortcut } from '../graph/source';
import { isWithin } from '../graph/tree-changes';
import type { LocalProject, OpenResult } from '../local/projects';
import { openProject } from '../local/projects';
import { disposeModel } from '../monaco/models';
import { textVersion } from '../storage/browser-storage';
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
/** The graph has edits the code doesn't have yet: saving is blocked. */
const outOfSync = ref(false);
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

/** The folder: drafts, tabs and editor state belong to it. */
const scope = computed(() => `local/${id.value}`);

/** Open files of this folder: the one on screen, tabs and drafts. */
const {
  file,
  text,
  overlay,
  dirty,
  loadingFile,
  fileError,
  tabs: fileTabs,
  dirtyTabs,
  changedFiles,
  openText,
  loadFile,
  closeTab: closeSessionTab,
  closeOtherTabs: closeSessionOthers,
  closeAllTabs: closeSessionAll,
  discard: discardChanges,
  outdated,
  restoreOutdated,
  dropOutdated,
  editFile,
  markSaved,
  replaceShown,
  movePath,
  forgetPath,
} = useFileSession({
  scope,
  path,
  isFile,
  read: async (filePath) => {
    if (!project.value) {
      throw new Error('No folder open');
    }

    const content = await project.value.read(filePath);
    // A file on disk has no version of its own: a short hash of its text.
    return { path: filePath, content, version: textVersion(content) };
  },
  // Read-only folders are gone after a reload, so their drafts would be too.
  persistDrafts: () => project.value?.canWrite === true,
  dispose: disposeModel,
  onRestored: () => show('Restored your unsaved changes for this file.'),
});

/** Path of the file on screen (the next one shows once it was read). */
const shown = computed(() => file.value?.path ?? null);
/** Content of the open file on disk (`null` while none is open). */
const saved = computed(() => file.value?.content ?? null);

const layoutStore = computed(() =>
  shown.value ? localLayoutStore(`local/${id.value}:${shown.value}`) : null
);

let treeRequest = 0;

async function loadTree(): Promise<void> {
  if (!project.value) {
    return;
  }

  // A newer folder or refresh wins over a slow earlier one.
  const request = ++treeRequest;
  loadingTree.value = true;
  try {
    const listing = await project.value.list();
    if (request !== treeRequest) {
      return;
    }

    entries.value = listing.entries;
    if (listing.truncated) {
      show('This folder is large; the file list is truncated.');
    }
  } catch (error) {
    if (request === treeRequest) {
      show(`Reading the folder failed: ${(error as Error).message}`, 'error');
    }
  } finally {
    if (request === treeRequest) {
      loadingTree.value = false;
    }
  }
}

let openRequest = 0;

async function open(): Promise<void> {
  const request = ++openRequest;
  project.value = null;
  entries.value = null;
  const result = await openProject(id.value);
  if (request !== openRequest) {
    return;
  }

  opening.value = result;
  if (result.status === 'ready') {
    project.value = result.project;
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

// ---------------------------------------------------------------- tabs

/** Text of another file: an open tab's current text, else the file's. */
async function readFile(filePath: string): Promise<string> {
  const openTab = openText(filePath);
  if (openTab !== undefined) {
    return openTab;
  }

  if (!project.value) {
    throw new Error('No folder open');
  }

  return project.value.read(filePath);
}

function showNoFile(): void {
  void router.push({ name: 'local', params: { id: id.value, path: [] } });
}

const { closeTab, closeOtherTabs, closeAllTabs, pinFile } = useTabActions(
  {
    file,
    tabs: fileTabs,
    closeTab: closeSessionTab,
    closeOtherTabs: closeSessionOthers,
    closeAllTabs: closeSessionAll,
  },
  { path, selectFile, showNoFile }
);

watch(id, open, { immediate: true });
watch([entries, path], loadFile, { immediate: true });

async function save(): Promise<void> {
  if (!project.value || !dirty.value || saving.value) {
    return;
  }

  if (!project.value.canWrite) {
    show('This browser can only read folders. Use Chrome or Edge to save.');
    return;
  }

  if (outOfSync.value) {
    show(
      'The graph is not in sync with the code. Wire it so it can be code, or discard the graph-only changes, then save.',
      'error'
    );
    return;
  }

  // Everything about the file is taken now: the user may switch tabs while
  // it is written.
  const target = shown.value;
  const base = saved.value;
  if (target === null || base === null) {
    return;
  }

  saving.value = true;
  const content = text.value;
  try {
    // Changed on disk by another program since it was read: ask first.
    const onDisk = await project.value.read(target).catch(() => base);
    if (
      onDisk !== base &&
      !globalThis.confirm(
        `${target} was changed outside vizscript since it was opened. Overwrite those changes?`
      )
    ) {
      return;
    }

    await project.value.write(target, content);
    markSaved(target, content, textVersion(content));
  } catch (error) {
    show(`Saving failed: ${(error as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

function discard(): void {
  // Drops every unsaved change of the file at once: ask first.
  if (
    saved.value !== null &&
    globalThis.confirm(
      `Discard all changes to ${shown.value ?? 'this file'}? This can't be undone.`
    )
  ) {
    discardChanges();
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
  if (
    !project.value ||
    !shown.value ||
    loadingFile.value ||
    dirty.value ||
    saving.value
  ) {
    return;
  }

  const target = shown.value;
  const base = saved.value;
  try {
    const content = await project.value.read(target);
    // Only for the same file, still unchanged here.
    if (
      shown.value !== target ||
      saved.value !== base ||
      dirty.value ||
      saving.value
    ) {
      return;
    }

    if (content !== saved.value) {
      replaceShown({ path: target, content, version: textVersion(content) });
      version.value++;
    }
  } catch {
    // the file was removed or renamed; the tree refresh shows it
  }
});

// ------------------------------------------- create, rename, delete files

/** Files and folders can be created, renamed and deleted on disk. */
const canChangeFiles = computed(
  () =>
    project.value?.canWrite === true &&
    project.value.create !== undefined &&
    project.value.rename !== undefined &&
    project.value.remove !== undefined
);

/** Runs a change on disk, then lists the folder again. */
async function changeFiles(
  what: string,
  run: (folder: LocalProject) => Promise<void>
): Promise<boolean> {
  if (!project.value) {
    return false;
  }

  try {
    await run(project.value);
    return true;
  } catch (error) {
    show(`${what} failed: ${(error as Error).message}`, 'error');
    return false;
  } finally {
    await loadTree();
  }
}

async function createPath(target: string, kind: 'file' | 'dir'): Promise<void> {
  if (
    (await changeFiles('Creating', (folder) =>
      folder.create ? folder.create(target, kind) : Promise.resolve()
    )) &&
    kind === 'file'
  ) {
    pinFile(target);
  }
}

async function renameFile(from: string, to: string): Promise<void> {
  const shownPath = path.value;
  if (
    await changeFiles('Renaming', (folder) =>
      folder.rename ? folder.rename(from, to) : Promise.resolve()
    )
  ) {
    movePath(from, to);
    if (isWithin(shownPath, from)) {
      selectFile(to + shownPath.slice(from.length));
    }
  }
}

async function removeFile(target: string, kind: 'file' | 'dir'): Promise<void> {
  if (
    !globalThis.confirm(
      `Delete ${target}${kind === 'dir' ? ' and everything in it' : ''} from your disk? This can't be undone.`
    )
  ) {
    return;
  }

  const shownPath = path.value;
  if (
    await changeFiles('Deleting', (folder) =>
      folder.remove ? folder.remove(target) : Promise.resolve()
    )
  ) {
    forgetPath(target);
    if (isWithin(shownPath, target)) {
      const next = fileTabs.tabs.value[0]?.path;
      if (next) {
        selectFile(next);
      } else {
        showNoFile();
      }
    }
  }
}

/** Opens a file, optionally at the definition of `symbol`. */
function selectFile(next: string, symbol?: string): void {
  workbench.mobileDrawer = false;
  void router.push({
    name: 'local',
    params: { id: id.value, path: next.split('/') },
    query: symbol ? { symbol } : {},
  });
}

/** Older unsaved edits are dropped for good: ask first. */
function dropOutdatedEdits(): void {
  if (
    globalThis.confirm(
      "Discard your unsaved edits from the older version of this file? This can't be undone."
    )
  ) {
    dropOutdated();
  }
}
</script>

<template>
  <Workbench>
    <WorkbenchView id="explorer">
      <div data-ui="explorer" class="flex h-full min-h-0 flex-col">
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
          :changed="changedFiles"
          :editable="canChangeFiles"
          @select="selectFile"
          @pin="pinFile"
          @create="createPath"
          @rename="renameFile"
          @remove="removeFile"
        />
      </div>
    </WorkbenchView>

    <!-- Re-created when the layout switches between phone and desktop. -->
    <Teleport
      :key="String(workbench.isMobile)"
      defer
      to="#workbench-editor-tabs"
    >
      <FileTabs
        :tabs="fileTabs.tabs.value"
        :active="shown"
        :dirty="dirtyTabs"
        @select="selectFile"
        @pin="fileTabs.pin"
        @close="closeTab"
        @close-others="closeOtherTabs"
        @close-all="closeAllTabs"
        @move="fileTabs.move"
      />
    </Teleport>

    <ScriptWorkspace
      v-if="project && shown !== null && saved !== null"
      :key="`${id}:${shown}:${version}`"
      v-model:text="text"
      v-model:overlay="overlay"
      :path="shown"
      :layout-store="layoutStore"
      :state-key="`local/${id}:${shown}`"
      :files="files"
      :read-file="readFile"
      :base-text="saved"
      hide-share
      :editor-scope="scope"
      :edit-file="editFile"
      @open="selectFile"
      @out-of-sync="outOfSync = $event"
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
        <span
          v-if="loadingFile"
          class="i-mdi-loading shrink-0 animate-spin text-zinc-500"
          role="status"
          aria-label="Loading the file"
        />
        <OutdatedDraftNotice
          v-if="outdated && outdated.path === file?.path"
          @restore="restoreOutdated"
          @discard="dropOutdatedEdits"
        />
        <template v-if="dirty">
          <span
            class="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300"
            >modified</span
          >
          <button
            v-if="project.canWrite"
            type="button"
            class="btn-ghost shrink-0 px-2 text-xs"
            :title="
              outOfSync
                ? 'The graph is not in sync with the code yet'
                : `Save to disk (${shortcut('S')})`
            "
            :disabled="saving || outOfSync"
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
        data-ui="workspace-toolbar"
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
