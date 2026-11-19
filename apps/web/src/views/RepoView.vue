<script setup lang="ts">
import type {
  BranchSummary,
  ProviderId,
  TreeResponse,
} from '@vizscript/api-contract';
import { until, useDebounceFn } from '@vueuse/core';
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import { repoSource } from '../api/repo-source';
import BranchStatus from '../components/BranchStatus.vue';
import FileTabs from '../components/FileTabs.vue';
import FileTree from '../components/FileTree.vue';
import GithubLimitStatus from '../components/GithubLimitStatus.vue';
import OutdatedDraftNotice from '../components/OutdatedDraftNotice.vue';
import RepoAccessHint from '../components/RepoAccessHint.vue';
import ScriptWorkspace from '../components/ScriptWorkspace.vue';
import { trackTask } from '../composables/use-background-tasks';
import { useFileSession } from '../composables/use-file-session';
import { useTabActions } from '../composables/use-tab-actions';
import { useToasts } from '../composables/use-toasts';
import { useTreeChanges } from '../composables/use-tree-changes';
import type { LayoutStore } from '../graph/layout-store';
import { repoLayoutStore } from '../graph/layout-store';
import { looksLikeFile } from '../graph/project-files';
import {
  changedTree,
  createFile,
  createFolder,
  currentFiles,
  isWithin,
  removePath,
  renamePath,
  restorePath,
  sameTree,
  sourceOf,
} from '../graph/tree-changes';
import { disposeModel } from '../monaco/models';
import type { BlobKey, TreeKey } from '../storage/blob-cache';
import {
  cachedBlob,
  cachedTree,
  storeBlob,
  storeTree,
} from '../storage/blob-cache';
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
/** The tree came from GitHub now, not from the last visit. */
const treeFresh = ref(false);

/** Files created, renamed and deleted here, kept in the browser. */
const treeChanges = useTreeChanges(scope);

/** The tree with those changes, deleted files still listed. */
const shownTree = computed(() =>
  tree.value ? changedTree(tree.value.entries, treeChanges.changes.value) : null
);

/** The files there are now. */
const files = computed(() =>
  currentFiles(tree.value?.entries ?? [], treeChanges.changes.value)
);

/**
 * Whether the path is a file: as the tree says, or, while it loads (GitHub
 * takes seconds for big trees), a name with an extension, so the file
 * loads at the same time.
 */
const isFile = computed(() => {
  if (path.value === '') {
    return false;
  }

  // A file new since the last visit isn't in the kept tree yet.
  return (
    files.value.has(path.value) ||
    (!treeFresh.value && loadingTree.value && looksLikeFile(path.value))
  );
});

/** The files of the branch, once the tree is known. */
const knownFiles = computed(() => (tree.value ? files.value : undefined));

/**
 * Reads a file of the branch: new ones are empty, moved ones read their
 * original. `keptTree`: a sha of the last visit's tree will do (imported
 * files, read again if the fresh tree differs); a file the user edits only
 * trusts the fresh tree.
 */
async function readRepoFile(
  filePath: string,
  keptTree = false
): Promise<{
  path: string;
  content: string;
  version: string;
  /** Read by a sha of the last visit's tree: it may be outdated. */
  kept?: boolean;
}> {
  const original = sourceOf(treeChanges.changes.value, filePath);
  if (original === '') {
    return { path: filePath, content: '', version: 'new' };
  }

  // The tree names the content: read before, it comes from the cache.
  const stored = original ?? filePath;
  const sha = treeFresh.value || keptTree ? shas.value.get(stored) : undefined;
  const key = (blob: string): BlobKey => ({
    provider: provider.value,
    owner: owner.value,
    repo: repo.value,
    sha: blob,
  });
  const cached = sha === undefined ? undefined : await cachedBlob(key(sha));
  if (sha !== undefined && cached !== undefined) {
    return {
      path: filePath,
      content: cached,
      version: sha,
      ...(treeFresh.value ? {} : { kept: true }),
    };
  }

  const loaded = await source.value.getFile(
    owner.value,
    repo.value,
    ref_.value,
    stored
  );
  void storeBlob(key(loaded.sha), loaded.content);
  return { path: filePath, content: loaded.content, version: loaded.sha };
}

/** Reads of files to open that are still on their way, by path. */
const opening = new Map<
  string,
  Promise<{ path: string; content: string; version: string }>
>();

/**
 * Files opened by a sha of the last visit's tree, with that sha: checked
 * when GitHub's tree arrives.
 */
const openedFromKept = new Map<string, string>();

/** The kept tree being looked up (opening a file waits for it). */
let keptTreeLookup: Promise<unknown> = Promise.resolve();

async function openKeptOrFresh(
  filePath: string
): Promise<{ path: string; content: string; version: string }> {
  // The kept tree's sha, if its content is cached: shown at once. Looking
  // the kept tree up takes milliseconds.
  await keptTreeLookup;
  const { kept, ...loaded } = await readRepoFile(filePath, true);
  if (kept) {
    openedFromKept.set(filePath, loaded.version);
  }

  return loaded;
}

/**
 * Files opened from the kept tree whose content changed on the branch:
 * shown again in the new version, unless edited already (their draft is
 * of the older version then, and is kept aside on the next load).
 */
async function checkOpenedFiles(): Promise<void> {
  const opened = [...openedFromKept];
  openedFromKept.clear();
  for (const [filePath, sha] of opened) {
    const stored = sourceOf(treeChanges.changes.value, filePath) ?? filePath;
    const fresh = shas.value.get(stored);
    if (fresh === undefined || fresh === sha) {
      continue;
    }

    const shown = file.value;
    if (shown?.path !== filePath || shown.version !== sha) {
      continue;
    }

    if (dirty.value) {
      show(
        `${filePath.split('/').at(-1) ?? filePath} changed on the branch since your last visit; your edits are on the older version.`
      );
      continue;
    }

    try {
      const loaded = await readRepoFile(filePath);
      if (file.value === shown && !dirty.value) {
        replaceShown(loaded);
      }
    } catch {
      // Unreadable now: the file stays as it is.
    }
  }
}

/**
 * A file to open: asked once while a read is on its way (the kept tree
 * and the fresh one each make the file load again).
 */
function openRepoFile(
  filePath: string
): Promise<{ path: string; content: string; version: string }> {
  const key = `${scope.value}:${filePath}`;
  let read = opening.get(key);
  if (!read) {
    read = openKeptOrFresh(filePath);
    opening.set(key, read);
    void (async (): Promise<void> => {
      try {
        await read;
      } catch {
        // The session shows the error.
      } finally {
        opening.delete(key);
      }
    })();
  }

  return read;
}

/** Blob shas of the branch's files, by path. */
const shas = computed(
  () =>
    new Map(
      (tree.value?.entries ?? []).flatMap((e) =>
        e.sha === undefined ? [] : [[e.path, e.sha] as const]
      )
    )
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
  replaceShown,
  movePath,
  forgetPath,
} = useFileSession({
  scope,
  path,
  isFile,
  read: (filePath) => openRepoFile(filePath),
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

async function loadBranches(request: number): Promise<void> {
  try {
    const list = await source.value.listBranches(owner.value, repo.value);
    if (request === treeRequest) {
      branches.value = list;
    }
  } catch {
    // The picker shows the current branch only.
    if (request === treeRequest) {
      branches.value = [];
    }
  }
}

function treeKey(): TreeKey {
  return {
    provider: provider.value,
    owner: owner.value,
    repo: repo.value,
    ref: ref_.value,
  };
}

async function loadTree(): Promise<void> {
  // A newer branch or repository wins over a slow earlier one.
  const request = ++treeRequest;
  loadingTree.value = true;
  treeFresh.value = false;
  tree.value = null;
  openedFromKept.clear();
  // The branch list is for the picker: nothing waits for it.
  void loadBranches(request);
  // The last visit's tree at once; GitHub's replaces it.
  const key = treeKey();
  const lookup = cachedTree(key);
  keptTreeLookup = lookup;
  const kept = await lookup;
  if (kept && request === treeRequest) {
    tree.value = kept;
  }

  try {
    const fetching = source.value.getTree(owner.value, repo.value, ref_.value);
    const t = kept
      ? await fetching
      : await trackTask('Loading the file list', fetching);
    if (request !== treeRequest) {
      return;
    }

    void storeTree(key, t);
    treeFresh.value = true;
    if (!kept || !sameTree(kept.entries, t.entries)) {
      // The branch moved: files read from the kept tree are read again.
      readCache.clear();
      tree.value = t;
      void checkOpenedFiles();
    } else {
      openedFromKept.clear();
    }

    if (t.truncated) {
      show('This repository is large; the file list is truncated.');
    }
  } catch (error) {
    // A 401 was told by the session already; the public source retries.
    const told = error instanceof ApiError && error.status === 401;
    if (request === treeRequest && !told) {
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
async function readFile(filePath: string): Promise<string> {
  const open = openText(filePath);
  if (open !== undefined) {
    return open;
  }

  // Whether it exists is known with the tree (the kept one will do).
  await until(() => tree.value !== null || !loadingTree.value).toBe(true);
  if (!files.value.has(filePath)) {
    throw new Error(`${filePath} was deleted.`);
  }

  let read = readCache.get(filePath);
  if (!read) {
    read = readRepoFile(filePath, true).then((f) => f.content);
    read.catch(() => readCache.delete(filePath));
    readCache.set(filePath, read);
  }

  return read;
}

watch(scope, () => readCache.clear());

/** Shows the folder view (no file) when the last tab closes. */
function showNoFile(): void {
  void router.push({ name: 'repo', params: { ...route.params, path: [] } });
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

// Also when signing in or out (an expired session): another source.
watch([provider, owner, repo, ref_, source], loadTree, { immediate: true });
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

const workspace =
  useTemplateRef<InstanceType<typeof ScriptWorkspace>>('workspace');

function discard(): void {
  // Drops every local change of the file at once: ask first.
  if (
    file.value &&
    globalThis.confirm(
      `Discard all changes to ${file.value.path}? This can't be undone.`
    )
  ) {
    workspace.value?.discardLayout();
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

/** Another branch (or tag, commit): the URL's file stays open. */
function switchBranch(next: string): void {
  void router.push({ name: 'repo', params: { ...route.params, ref: next } });
}

// ------------------------------------------- create, rename, delete files

/** The open file is gone: the next tab, else the folder. */
function showAnother(): void {
  const next = fileTabs.tabs.value[0]?.path;
  if (next) {
    selectFile(next);
  } else {
    showNoFile();
  }
}

function createPath(target: string, kind: 'file' | 'dir'): void {
  const changes = treeChanges.changes.value;
  treeChanges.set(
    kind === 'file'
      ? createFile(changes, target)
      : createFolder(changes, target)
  );
  if (kind === 'file') {
    pinFile(target);
  }
}

function renameFile(from: string, to: string): void {
  readCache.clear();
  const shown = path.value;
  treeChanges.set(renamePath(treeChanges.changes.value, files.value, from, to));
  movePath(from, to);
  if (isWithin(shown, from)) {
    selectFile(to + shown.slice(from.length));
  }
}

function removeFile(target: string): void {
  const changes = treeChanges.changes.value;
  // New files and unsaved text can't be restored: ask first.
  const lost =
    Object.keys(changes.added).some((p) => isWithin(p, target)) ||
    [...changedFiles.value].some((p) => isWithin(p, target));
  if (
    lost &&
    !globalThis.confirm(
      `Delete ${target}? Its unsaved changes are lost for good.`
    )
  ) {
    return;
  }

  readCache.clear();
  const shown = path.value;
  treeChanges.set(removePath(changes, files.value, target));
  forgetPath(target);
  if (isWithin(shown, target)) {
    showAnother();
  } else {
    show(`Deleted ${target}. Right-click it in the explorer to restore it.`);
  }
}

function restoreFile(target: string): void {
  readCache.clear();
  treeChanges.set(restorePath(treeChanges.changes.value, target));
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
    <!-- Before the workspace: the branch comes first in the status bar. -->
    <BranchStatus
      :current="ref_"
      :branches="branches"
      :unsaved="dirtyTabs.size"
      @switch="switchBranch"
    />
    <WorkbenchView id="explorer">
      <div data-ui="explorer" class="flex h-full min-h-0 flex-col">
        <div v-if="loadingTree && !tree" class="p-4 text-sm text-zinc-500">
          <span class="i-mdi-loading animate-spin" /> Loading…
        </div>
        <FileTree
          v-else-if="shownTree"
          :entries="shownTree.entries"
          :selected-path="path || null"
          :changed="changedFiles"
          :status="shownTree.status"
          editable
          @select="selectFile"
          @pin="pinFile"
          @create="createPath"
          @rename="renameFile"
          @remove="removeFile"
          @restore="restoreFile"
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
      ref="workspace"
      v-if="file"
      :key="`${ref_}:${file.path}:${file.version}`"
      v-model:text="text"
      v-model:overlay="overlay"
      :path="file.path"
      :layout-store="layoutStore"
      :state-key="`${provider}/${owner}/${repo}@${ref_}:${file.path}`"
      :files="knownFiles"
      :read-file="readFile"
      :base-text="file.content"
      :editor-scope="scope"
      :edit-file="editFile"
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
          <span v-if="loadingFile || (loadingTree && !tree)"
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
