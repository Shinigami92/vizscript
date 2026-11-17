<script setup lang="ts">
import type {
  BranchSummary,
  ProviderId,
  TreeResponse,
} from '@vizscript/api-contract';
import { useDebounceFn } from '@vueuse/core';
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { repoSource } from '../api/repo-source';
import FileTabs from '../components/FileTabs.vue';
import FileTree from '../components/FileTree.vue';
import GithubLimitStatus from '../components/GithubLimitStatus.vue';
import OutdatedDraftNotice from '../components/OutdatedDraftNotice.vue';
import RepoAccessHint from '../components/RepoAccessHint.vue';
import ScriptWorkspace from '../components/ScriptWorkspace.vue';
import { useFileSession } from '../composables/use-file-session';
import { useToasts } from '../composables/use-toasts';
import type { LayoutStore } from '../graph/layout-store';
import { repoLayoutStore } from '../graph/layout-store';
import { disposeModel } from '../monaco/models';
import { useRecentStore } from '../stores/recent';
import { useSessionStore } from '../stores/session';
import { useWorkbenchStore } from '../stores/workbench';
import LayoutMenu from '../workbench/LayoutMenu.vue';
import Workbench from '../workbench/Workbench.vue';
import WorkbenchView from '../workbench/WorkbenchView.vue';

const route = useRoute();
const router = useRouter();
const { show } = useToasts();
const workbench = useWorkbenchStore();
const session = useSessionStore();

const provider = computed(() => String(route.params.provider) as ProviderId);
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const ref_ = computed(() => String(route.params.ref ?? ''));
const path = computed(() => {
  const value = route.params.path;
  return Array.isArray(value) ? value.join('/') : (value ?? '');
});

/** Repository and branch: drafts, tabs and loaded files belong to it. */
const scope = computed(
  () => `${provider.value}/${owner.value}/${repo.value}@${ref_.value}`
);

/** Signed in: through the API; signed out: public repositories from GitHub. */
const source = computed(() => repoSource(provider.value, session.me !== null));

const tree = shallowRef<TreeResponse | null>(null);
const branches = shallowRef<BranchSummary[]>([]);
const loadingTree = ref(false);

const files = computed(
  () =>
    new Set(
      tree.value?.entries.filter((e) => e.type === 'file').map((e) => e.path)
    )
);

const isFile = computed(
  () =>
    path.value !== '' &&
    tree.value?.entries.some(
      (e) => e.path === path.value && e.type === 'file'
    ) === true
);

/** Open files of this branch: the one on screen, tabs and drafts. */
const {
  file,
  text,
  overlay,
  dirty,
  loadingFile,
  fileError,
  tabs: fileTabs,
  dirtyTabs,
  openText,
  loadFile,
  closeTab: closeSessionTab,
  closeOtherTabs: closeSessionOthers,
  closeAllTabs: closeSessionAll,
  discard: discardChanges,
  outdated,
  restoreOutdated,
  dropOutdated,
} = useFileSession({
  scope,
  path,
  isFile,
  read: async (filePath) => {
    const loaded = await source.value.getFile(
      owner.value,
      repo.value,
      ref_.value,
      filePath
    );
    return { path: loaded.path, content: loaded.content, version: loaded.sha };
  },
  dispose: disposeModel,
  onRestored: () => show('Restored your unsaved changes for this file.'),
});

/** Whether layout changes go to the shared layout (else this browser). */
const layoutShared = ref<boolean | null>(null);

const layoutStore = computed<LayoutStore | null>(() =>
  file.value
    ? repoLayoutStore(
        provider.value,
        owner.value,
        repo.value,
        ref_.value,
        file.value.path,
        (canWrite) => (layoutShared.value = canWrite)
      )
    : null
);

let treeRequest = 0;

async function loadTree(): Promise<void> {
  // A newer branch or repository wins over a slow earlier one.
  const request = ++treeRequest;
  loadingTree.value = true;
  tree.value = null;
  try {
    const [t, b] = await Promise.all([
      source.value.getTree(owner.value, repo.value, ref_.value),
      source.value.listBranches(owner.value, repo.value).catch(() => []),
    ]);
    if (request !== treeRequest) {
      return;
    }

    tree.value = t;
    branches.value = b;
    if (t.truncated) {
      show('This repository is large; the file list is truncated.');
    }
  } catch (error) {
    if (request === treeRequest) {
      show(
        `Loading the repository failed: ${(error as Error).message}`,
        'error'
      );
    }
  } finally {
    if (request === treeRequest) {
      loadingTree.value = false;
    }
  }
}

/** Files read for the declarations of imports (not opened). */
const readCache = new Map<string, Promise<string>>();

/** Text of another file: an open tab's current text, else the stored one. */
function readFile(filePath: string): Promise<string> {
  const open = openText(filePath);
  if (open !== undefined) {
    return Promise.resolve(open);
  }

  let read = readCache.get(filePath);
  if (!read) {
    read = source.value
      .getFile(owner.value, repo.value, ref_.value, filePath)
      .then((f) => f.content);
    read.catch(() => readCache.delete(filePath));
    readCache.set(filePath, read);
  }

  return read;
}

watch(scope, () => readCache.clear());

onBeforeUnmount(() => {
  for (const tab of fileTabs.tabs.value) {
    disposeModel(tab.path);
  }
});

/** Shows the folder view (no file) when the last tab closes. */
function showNoFile(): void {
  void router.push({ name: 'repo', params: { ...route.params, path: [] } });
}

function closeTab(tabPath: string): void {
  const next = closeSessionTab(tabPath);
  if (next !== undefined) {
    if (next) {
      selectFile(next);
    } else {
      showNoFile();
    }
  }
}

function closeOtherTabs(tabPath: string): void {
  closeSessionOthers(tabPath);
  if (tabPath !== file.value?.path) {
    selectFile(tabPath);
  }
}

function closeAllTabs(): void {
  closeSessionAll();
  showNoFile();
}

/** Double-click in the explorer: open in a tab that stays. */
function pinFile(next: string): void {
  fileTabs.open(next, { preview: false });
  if (next !== path.value) {
    selectFile(next);
  }
}

watch([provider, owner, repo, ref_], loadTree, { immediate: true });
watch([() => tree.value, path], loadFile, { immediate: true });

// Remember the repository (and the open file) in "recently opened".
const recent = useRecentStore();
const remember = useDebounceFn(() => {
  if (tree.value) {
    void recent.touch({
      provider: provider.value,
      owner: owner.value,
      repo: repo.value,
      ref: ref_.value,
      path: isFile.value ? path.value : null,
    });
  }
}, 600);
watch([() => tree.value, path], () => void remember(), { immediate: true });

function discard(): void {
  // Drops every local change of the file at once: ask first.
  if (
    file.value &&
    globalThis.confirm(
      `Discard all changes to ${file.value.path}? This can't be undone.`
    )
  ) {
    discardChanges();
  }
}

/** Opens a file, optionally at the definition of `symbol`. */
function selectFile(next: string, symbol?: string): void {
  workbench.mobileDrawer = false;
  // The camera (`?view=`) belongs to the previous file.
  void router.push({
    name: 'repo',
    params: { ...route.params, path: next.split('/') },
    query: symbol ? { symbol } : {},
  });
}

function switchBranch(event: Event): void {
  const next = (event.target as HTMLSelectElement).value;
  void router.push({ name: 'repo', params: { ...route.params, ref: next } });
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
    <GithubLimitStatus v-if="!session.me" />
    <WorkbenchView id="explorer">
      <div data-ui="explorer" class="flex h-full min-h-0 flex-col">
        <div
          class="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2"
        >
          <span class="i-mdi-source-branch text-zinc-500" />
          <select
            class="min-w-0 flex-1 truncate bg-transparent text-sm text-zinc-200 outline-none"
            aria-label="Branch"
            :value="ref_"
            @change="switchBranch"
          >
            <option v-if="!branches.some((b) => b.name === ref_)" :value="ref_">
              {{ ref_ }}
            </option>
            <option
              v-for="branch in branches"
              :key="branch.name"
              :value="branch.name"
            >
              {{ branch.name }}
            </option>
          </select>
        </div>
        <div v-if="loadingTree" class="p-4 text-sm text-zinc-500">
          <span class="i-mdi-loading animate-spin" /> Loading…
        </div>
        <FileTree
          v-else-if="tree"
          :entries="tree.entries"
          :selected-path="path || null"
          @select="selectFile"
          @pin="pinFile"
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
        :active="file?.path ?? null"
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
      v-if="file"
      :key="`${ref_}:${file.path}:${file.version}`"
      v-model:text="text"
      v-model:overlay="overlay"
      :path="file.path"
      :layout-store="layoutStore"
      :state-key="`${provider}/${owner}/${repo}@${ref_}:${file.path}`"
      :files="files"
      :read-file="readFile"
      :base-text="file.content"
      keep-editor
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
          :title="loadingFile ? path : file.path"
          >{{ loadingFile ? path : file.path }}</span
        >
        <RepoAccessHint :shared="layoutShared" />
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
            type="button"
            class="btn-ghost shrink-0 px-2 text-xs"
            title="Discard local changes"
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
        <span class="truncate text-sm text-zinc-400"
          >{{ owner }}/{{ repo }}</span
        >
        <div class="ml-auto">
          <LayoutMenu />
        </div>
      </div>
      <WorkbenchView id="code">
        <div
          class="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-500"
        >
          <span v-if="loadingFile || loadingTree"
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
