<script setup lang="ts">
import type { TreeEntry } from '@vizscript/api-contract';
import { computed, ref, watch } from 'vue';
import { fileIcon, isPreviewable, isVisualizable } from '../graph/languages';

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: TreeEntry[];
}

interface Row {
  path: string;
  name: string;
  depth: number;
  type: 'file' | 'dir';
  open?: boolean;
}

const props = defineProps<{
  entries: TreeEntry[];
  selectedPath: string | null;
}>();

const emit = defineEmits<{
  select: [path: string];
  /** Double-click: open the file in a tab that stays (not a preview). */
  pin: [path: string];
}>();

const filter = ref('');
const expanded = ref(new Set<string>());

const root = computed<DirNode>(() => {
  const top: DirNode = { name: '', path: '', dirs: new Map(), files: [] };
  for (const entry of props.entries) {
    const parts = entry.path.split('/');
    let dir = top;
    const dirParts = entry.type === 'dir' ? parts : parts.slice(0, -1);
    for (const [index, part] of dirParts.entries()) {
      let child = dir.dirs.get(part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          dirs: new Map(),
          files: [],
        };
        dir.dirs.set(part, child);
      }

      dir = child;
    }

    if (entry.type === 'file') {
      dir.files.push(entry);
    }
  }

  return top;
});

// Expand the folders containing the selected file.
watch(
  () => props.selectedPath,
  (path) => {
    if (!path) {
      return;
    }

    const parts = path.split('/');
    const next = new Set(expanded.value);
    for (let i = 1; i < parts.length; i++) {
      next.add(parts.slice(0, i).join('/'));
    }

    expanded.value = next;
  },
  { immediate: true }
);

const rows = computed<Row[]>(() => {
  const query = filter.value.trim().toLowerCase();
  if (query) {
    return props.entries
      .filter((e) => e.type === 'file' && e.path.toLowerCase().includes(query))
      .slice(0, 500)
      .map((e) => ({
        path: e.path,
        name: e.path,
        depth: 0,
        type: 'file' as const,
      }));
  }

  const result: Row[] = [];
  const walk = (dir: DirNode, depth: number): void => {
    const dirs = [...dir.dirs.values()].toSorted((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const child of dirs) {
      const open = expanded.value.has(child.path);
      result.push({
        path: child.path,
        name: child.name,
        depth,
        type: 'dir',
        open,
      });
      if (open) {
        walk(child, depth + 1);
      }
    }

    const files = dir.files.toSorted((a, b) => a.path.localeCompare(b.path));
    for (const file of files) {
      result.push({
        path: file.path,
        name: file.path.split('/').pop() ?? file.path,
        depth,
        type: 'file',
      });
    }
  };
  walk(root.value, 0);
  return result;
});

function toggle(row: Row): void {
  if (row.type === 'file') {
    emit('select', row.path);
    return;
  }

  const next = new Set(expanded.value);
  if (next.has(row.path)) {
    next.delete(row.path);
  } else {
    next.add(row.path);
  }

  expanded.value = next;
}

function icon(row: Row): string {
  if (row.type === 'dir') {
    return row.open
      ? 'i-mdi-folder-open text-amber-300/80'
      : 'i-mdi-folder text-amber-300/80';
  }

  return fileIcon(row.path);
}
</script>

<template>
  <div data-ui="file-tree" class="flex h-full min-h-0 flex-col">
    <div class="p-2">
      <input
        v-model="filter"
        class="input py-1.5"
        placeholder="Filter files…"
        type="search"
      />
    </div>
    <ul class="min-h-0 flex-1 overflow-auto pb-4 text-sm" role="tree">
      <li v-for="row in rows" :key="row.path" role="treeitem">
        <button
          type="button"
          class="flex w-full items-center gap-1.5 truncate py-0.5 pr-2 text-left hover:bg-zinc-800/80"
          :class="[
            row.path === selectedPath
              ? 'bg-zinc-800 text-zinc-50'
              : 'text-zinc-300',
            row.type === 'file' &&
            !isVisualizable(row.path) &&
            !isPreviewable(row.path)
              ? 'opacity-70'
              : '',
          ]"
          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
          :title="row.path"
          @click="toggle(row)"
          @dblclick="row.type === 'file' && emit('pin', row.path)"
        >
          <span class="shrink-0" :class="icon(row)" />
          <span class="truncate">{{ row.name }}</span>
          <span
            v-if="row.type === 'file' && isVisualizable(row.path)"
            class="i-mdi-sitemap-outline ml-auto shrink-0 text-xs text-amber-400/70"
            title="Can be visualized"
          />
          <span
            v-else-if="row.type === 'file' && isPreviewable(row.path)"
            class="i-mdi-eye-outline ml-auto shrink-0 text-xs text-sky-400/70"
            title="Has a rendered preview"
          />
        </button>
      </li>
      <li v-if="rows.length === 0" class="px-3 py-2 text-zinc-500">No files</li>
    </ul>
  </div>
</template>
