<script setup lang="ts">
import type { TreeEntry } from '@vizscript/api-contract';
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import { fileIcon, isPreviewable, isVisualizable } from '../graph/languages';
import type { FileStatus } from '../graph/tree-changes';
import { parentsOf, pathError } from '../graph/tree-changes';
import type { MenuEntry } from './ContextMenu.vue';
import ContextMenu from './ContextMenu.vue';

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
  /** `new`: the name field of a file or folder being created. */
  type: 'file' | 'dir' | 'new';
  open?: boolean;
}

type Kind = 'file' | 'dir';

/** A name being typed: a new file or folder in `parent`, or a rename. */
type Naming =
  | { mode: 'create'; kind: Kind; parent: string }
  | { mode: 'rename'; kind: Kind; path: string };

const props = defineProps<{
  entries: TreeEntry[];
  selectedPath: string | null;
  /** Files with unsaved changes: marked like VS Code's modified files. */
  changed?: ReadonlySet<string>;
  /** New and deleted files (repositories keep them until saved). */
  status?: ReadonlyMap<string, FileStatus>;
  /** Files and folders can be created, renamed and deleted. */
  editable?: boolean;
}>();

const emit = defineEmits<{
  select: [path: string];
  /** Double-click: open the file in a tab that stays (not a preview). */
  pin: [path: string];
  create: [path: string, kind: Kind];
  rename: [from: string, to: string];
  remove: [path: string, kind: Kind];
  restore: [path: string];
}>();

const filter = ref('');

/** Folders holding a changed file, at any depth. */
const changedDirs = computed(() => {
  const dirs = new Set<string>();
  for (const path of props.changed ?? []) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }

  return dirs;
});

function isChanged(row: Row): boolean {
  return row.type === 'file'
    ? (props.changed?.has(row.path) ?? false) ||
        props.status?.get(row.path) === 'added'
    : changedDirs.value.has(row.path);
}

function statusOf(row: Row): FileStatus | undefined {
  return row.type === 'file' ? props.status?.get(row.path) : undefined;
}

/** The file's letter, like VS Code's: Added, Deleted, Modified. */
function markOf(row: Row): string {
  const status = statusOf(row);
  if (status) {
    return status === 'added' ? 'A' : 'D';
  }

  return isChanged(row) ? 'M' : '';
}

const MARK_TITLES: Record<string, string> = {
  A: 'New, not saved yet',
  D: 'Deleted, not saved yet',
  M: 'Unsaved changes',
};
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

// A name being typed (create, rename) and the context menu.
const naming = ref<Naming | null>(null);
const name = ref('');
const field = useTemplateRef<HTMLInputElement[]>('field');
/** The row last clicked: new files go into its folder. */
const current = ref<Row | null>(null);
const menu = ref<{ x: number; y: number; row: Row | null } | null>(null);

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
  const creating = naming.value?.mode === 'create' ? naming.value : null;
  if (creating) {
    // At the top of the folder it goes into.
    const at = creating.parent
      ? result.findIndex((r) => r.path === creating.parent)
      : -1;
    const parent = result[at];
    result.splice(at + 1, 0, {
      path: '\0new',
      name: '',
      depth: parent ? parent.depth + 1 : 0,
      type: 'new',
    });
  }

  return result;
});

function toggle(row: Row): void {
  current.value = row;
  if (row.type === 'new') {
    return;
  }

  if (row.type === 'file') {
    if (statusOf(row) !== 'deleted') {
      emit('select', row.path);
    }

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

// ------------------------------------------------- create, rename, delete

/**
 * Paths there are now: deleted files are free again, and so are folders
 * holding only deleted files.
 */
const taken = computed(() => {
  const holding = new Set<string>();
  const live = new Set<string>();
  for (const entry of props.entries) {
    if (entry.type === 'file') {
      const gone = props.status?.get(entry.path) === 'deleted';
      for (const dir of parentsOf(entry.path)) {
        holding.add(dir);
        if (!gone) {
          live.add(dir);
        }
      }

      if (!gone) {
        live.add(entry.path);
      }
    }
  }

  return new Set(
    props.entries
      .filter((e) =>
        e.type === 'file'
          ? live.has(e.path)
          : live.has(e.path) || !holding.has(e.path)
      )
      .map((e) => e.path)
  );
});

function folderOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

/** Where the typed name puts the file or folder. */
const target = computed(() => {
  const value = naming.value;
  const typed = name.value.trim().replace(/^\/+/, '');
  if (!value) {
    return '';
  }

  const folder = value.mode === 'create' ? value.parent : folderOf(value.path);
  return folder ? `${folder}/${typed}` : typed;
});

/** The typed name's icon: a folder, or the file type it names. */
const namingIcon = computed(() =>
  naming.value?.kind === 'dir'
    ? 'i-mdi-folder text-amber-300/80'
    : fileIcon(target.value || 'file')
);

const nameError = computed(() => {
  const value = naming.value;
  if (!value || (value.mode === 'rename' && target.value === value.path)) {
    return undefined;
  }

  return pathError(taken.value, target.value);
});

async function startNaming(next: Naming): Promise<void> {
  menu.value = null;
  filter.value = '';
  naming.value = next;
  name.value =
    next.mode === 'rename' ? (next.path.split('/').at(-1) ?? '') : '';
  if (next.mode === 'create' && next.parent) {
    const parts = next.parent.split('/');
    const open = new Set(expanded.value);
    parts.forEach((_, i) => open.add(parts.slice(0, i + 1).join('/')));
    expanded.value = open;
  }

  await nextTick();
  const input = field.value?.[0];
  input?.focus();
  // Like VS Code: the name without its extension is selected.
  const dot = name.value.lastIndexOf('.');
  input?.setSelectionRange(0, dot > 0 ? dot : name.value.length);
}

/** The folder a new file goes into from a row (none: the top). */
function folderFor(row: Row | null): string {
  if (!row || row.type === 'new') {
    return '';
  }

  return row.type === 'dir' ? row.path : folderOf(row.path);
}

function create(kind: Kind, row = current.value): void {
  void startNaming({ mode: 'create', kind, parent: folderFor(row) });
}

function rename(row: Row): void {
  if (row.type !== 'new') {
    void startNaming({ mode: 'rename', kind: row.type, path: row.path });
  }
}

function remove(row: Row): void {
  if (row.type !== 'new' && statusOf(row) !== 'deleted') {
    emit('remove', row.path, row.type);
  }
}

function finishNaming(commit: boolean): void {
  const value = naming.value;
  if (!value) {
    return;
  }

  // Read before the field closes: both follow `naming`.
  const to = target.value;
  const invalid = name.value.trim() === '' || nameError.value !== undefined;
  naming.value = null;
  if (!commit || invalid) {
    return;
  }

  if (value.mode === 'create') {
    emit('create', to, value.kind);
  } else if (to !== value.path) {
    emit('rename', value.path, to);
  }
}

function onFieldKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !nameError.value) {
    event.preventDefault();
    finishNaming(true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    finishNaming(false);
  }
}

function onRowKeydown(event: KeyboardEvent, row: Row): void {
  if (!props.editable) {
    return;
  }

  if (event.key === 'F2') {
    event.preventDefault();
    rename(row);
  } else if (
    event.key === 'Delete' ||
    (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))
  ) {
    event.preventDefault();
    remove(row);
  }
}

function openMenu(event: MouseEvent, row: Row | null): void {
  if (props.editable) {
    event.preventDefault();
    current.value = row;
    menu.value = { x: event.clientX, y: event.clientY, row };
  }
}

const menuEntries = computed<MenuEntry[]>(() => {
  const row = menu.value?.row ?? null;
  if (row && statusOf(row) === 'deleted') {
    return [
      { type: 'header', label: row.name },
      {
        label: 'Restore',
        icon: 'i-mdi-restore',
        action: () => emit('restore', row.path),
      },
    ];
  }

  const entries: MenuEntry[] = [
    ...(row ? [{ type: 'header' as const, label: row.name }] : []),
    {
      label: 'New File…',
      icon: 'i-mdi-file-plus-outline',
      action: () => create('file', row),
    },
    {
      label: 'New Folder…',
      icon: 'i-mdi-folder-plus-outline',
      action: () => create('dir', row),
    },
  ];
  if (row) {
    entries.push(
      { type: 'separator' },
      {
        label: 'Rename…',
        icon: 'i-mdi-rename-outline',
        shortcut: 'F2',
        action: () => rename(row),
      },
      {
        label: 'Delete',
        icon: 'i-mdi-delete-outline',
        shortcut: 'Del',
        danger: true,
        action: () => remove(row),
      }
    );
  }

  return entries;
});
</script>

<template>
  <div data-ui="file-tree" class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-1 p-2">
      <input
        v-model="filter"
        class="input min-w-0 flex-1 py-1.5"
        placeholder="Filter files…"
        type="search"
      />
      <template v-if="editable">
        <button
          type="button"
          class="btn-ghost shrink-0 px-1.5"
          title="New File…"
          aria-label="New file"
          @click="create('file')"
        >
          <span class="i-mdi-file-plus-outline" />
        </button>
        <button
          type="button"
          class="btn-ghost shrink-0 px-1.5"
          title="New Folder…"
          aria-label="New folder"
          @click="create('dir')"
        >
          <span class="i-mdi-folder-plus-outline" />
        </button>
      </template>
    </div>
    <ul
      class="min-h-0 flex-1 overflow-auto pb-4 text-sm"
      role="tree"
      @contextmenu.self="openMenu($event, null)"
    >
      <li v-for="row in rows" :key="row.path" role="treeitem">
        <!-- A name being typed: a new file or folder, or a rename. -->
        <div
          v-if="
            naming &&
            (row.type === 'new' ||
              (naming.mode === 'rename' && naming.path === row.path))
          "
          class="relative flex items-center gap-1.5 py-0.5 pr-2"
          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        >
          <span class="shrink-0" :class="namingIcon" />
          <input
            ref="field"
            v-model="name"
            data-ui="file-name-field"
            class="input min-w-0 flex-1 px-1 py-0 font-mono text-xs"
            :class="nameError ? 'border-red-500' : ''"
            :aria-label="
              naming.mode === 'rename'
                ? `New name of ${row.name}`
                : naming.kind === 'dir'
                  ? 'Name of the new folder'
                  : 'Name of the new file'
            "
            :aria-invalid="nameError !== undefined"
            spellcheck="false"
            @keydown="onFieldKeydown"
            @blur="finishNaming(true)"
          />
          <p
            v-if="nameError"
            role="alert"
            class="absolute top-full right-2 left-8 z-10 rounded-b border border-red-500 bg-red-950 px-1.5 py-0.5 text-xs text-red-200"
          >
            {{ nameError }}
          </p>
        </div>
        <button
          v-else
          type="button"
          class="flex w-full items-center gap-1.5 truncate py-0.5 pr-2 text-left hover:bg-zinc-800/80"
          :class="[
            row.path === selectedPath ? 'bg-zinc-800' : '',
            statusOf(row) === 'deleted'
              ? 'text-red-400/80'
              : statusOf(row) === 'added'
                ? 'text-emerald-300'
                : isChanged(row)
                  ? 'text-amber-300'
                  : row.path === selectedPath
                    ? 'text-zinc-50'
                    : 'text-zinc-300',
            row.type === 'file' &&
            !isVisualizable(row.path) &&
            !isPreviewable(row.path)
              ? 'opacity-70'
              : '',
          ]"
          :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
          :title="
            statusOf(row) === 'deleted'
              ? `${row.path} — deleted; right-click to restore`
              : row.path
          "
          @click="toggle(row)"
          @dblclick="
            row.type === 'file' &&
            statusOf(row) !== 'deleted' &&
            emit('pin', row.path)
          "
          @keydown="onRowKeydown($event, row)"
          @contextmenu="openMenu($event, row)"
        >
          <span class="shrink-0" :class="icon(row)" />
          <span
            class="truncate"
            :class="statusOf(row) === 'deleted' ? 'line-through' : ''"
            >{{ row.name }}</span
          >
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
          <!-- A column of its own, so the icons before it stay aligned. -->
          <span
            v-if="row.type === 'file'"
            class="w-3 shrink-0 text-center text-xs font-semibold"
            :class="
              isVisualizable(row.path) || isPreviewable(row.path)
                ? 'ml-1'
                : 'ml-auto'
            "
            :title="MARK_TITLES[markOf(row)]"
            >{{ markOf(row) }}</span
          >
          <span
            v-else-if="isChanged(row)"
            class="mr-1 ml-auto size-1.5 shrink-0 rounded-full bg-amber-300/80"
            title="Holds unsaved changes"
          />
        </button>
      </li>
      <li
        v-if="rows.length === 0"
        class="px-3 py-2 text-zinc-500"
        @contextmenu="openMenu($event, null)"
      >
        No files
      </li>
    </ul>
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :entries="menuEntries"
      label="File actions"
      @close="menu = null"
    />
  </div>
</template>
