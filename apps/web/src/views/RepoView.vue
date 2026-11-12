<script setup lang="ts">
import type {
  BranchSummary,
  FileResponse,
  ProviderId,
  TreeResponse,
} from '@vizscript/api-contract';
import { useDebounceFn } from '@vueuse/core';
import { computed, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import FileTree from '../components/FileTree.vue';
import ScriptWorkspace from '../components/ScriptWorkspace.vue';
import { useToasts } from '../composables/use-toasts';
import type { LayoutStore } from '../graph/layout-store';
import { apiLayoutStore } from '../graph/layout-store';
import { useRecentStore } from '../stores/recent';
import { useWorkbenchStore } from '../stores/workbench';
import LayoutMenu from '../workbench/LayoutMenu.vue';
import Workbench from '../workbench/Workbench.vue';
import WorkbenchView from '../workbench/WorkbenchView.vue';

const route = useRoute();
const router = useRouter();
const { show } = useToasts();
const workbench = useWorkbenchStore();

const provider = computed(() => String(route.params.provider) as ProviderId);
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const ref_ = computed(() => String(route.params.ref ?? ''));
const path = computed(() => {
  const value = route.params.path;
  return Array.isArray(value) ? value.join('/') : (value ?? '');
});

const tree = shallowRef<TreeResponse | null>(null);
const branches = shallowRef<BranchSummary[]>([]);
const file = shallowRef<FileResponse | null>(null);
const text = ref('');
const loadingTree = ref(false);
const loadingFile = ref(false);
const fileError = ref<string | null>(null);

const draftKey = computed(
  () =>
    `vizscript:draft:${provider.value}/${owner.value}/${repo.value}@${ref_.value}:${path.value}`
);
const dirty = computed(
  () => file.value !== null && text.value !== file.value.content
);

const layoutStore = computed<LayoutStore | null>(() =>
  file.value
    ? apiLayoutStore(
        provider.value,
        owner.value,
        repo.value,
        ref_.value,
        file.value.path
      )
    : null
);

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

async function loadTree(): Promise<void> {
  loadingTree.value = true;
  tree.value = null;
  try {
    const [t, b] = await Promise.all([
      api.getTree(provider.value, owner.value, repo.value, ref_.value),
      api.listBranches(provider.value, owner.value, repo.value).catch(() => []),
    ]);
    tree.value = t;
    branches.value = b;
    if (t.truncated) {
      show('This repository is large; the file list is truncated.');
    }
  } catch (error) {
    show(`Loading the repository failed: ${(error as Error).message}`, 'error');
  } finally {
    loadingTree.value = false;
  }
}

async function loadFile(): Promise<void> {
  file.value = null;
  fileError.value = null;
  if (!isFile.value) {
    return;
  }

  loadingFile.value = true;
  try {
    const loaded = await api.getFile(
      provider.value,
      owner.value,
      repo.value,
      ref_.value,
      path.value
    );
    let initial = loaded.content;
    try {
      const draft = JSON.parse(
        localStorage.getItem(draftKey.value) ?? 'null'
      ) as { sha: string; text: string } | null;
      if (draft?.sha === loaded.sha && draft.text !== loaded.content) {
        initial = draft.text;
        show('Restored your unsaved changes for this file.');
      }
    } catch {
      // ignore broken drafts
    }

    text.value = initial;
    file.value = loaded;
  } catch (error) {
    fileError.value = (error as Error).message;
  } finally {
    loadingFile.value = false;
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

const saveDraft = useDebounceFn(() => {
  if (!file.value) {
    return;
  }

  try {
    if (dirty.value) {
      localStorage.setItem(
        draftKey.value,
        JSON.stringify({ sha: file.value.sha, text: text.value })
      );
    } else {
      localStorage.removeItem(draftKey.value);
    }
  } catch {
    // storage unavailable
  }
}, 500);

watch(text, saveDraft);

function discard(): void {
  if (file.value) {
    text.value = file.value.content;
    localStorage.removeItem(draftKey.value);
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
</script>

<template>
  <Workbench>
    <WorkbenchView id="explorer">
      <div class="flex h-full min-h-0 flex-col">
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
        />
      </div>
    </WorkbenchView>

    <ScriptWorkspace
      v-if="file"
      :key="`${ref_}:${file.path}:${file.sha}`"
      v-model:text="text"
      :path="file.path"
      :layout-store="layoutStore"
      :state-key="`${provider}/${owner}/${repo}@${ref_}:${file.path}`"
      :files="files"
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
          :title="file.path"
          >{{ file.path }}</span
        >
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
