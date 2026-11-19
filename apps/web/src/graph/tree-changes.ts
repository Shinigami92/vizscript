import type { TreeEntry } from '@vizscript/api-contract';

/**
 * Files created, renamed and deleted in a repository branch, kept in the
 * browser like the drafts of their text (repositories have no save yet).
 * A rename is a new path that reads the file it was moved from.
 */
export interface TreeChanges {
  /**
   * Files that aren't in the repository at their path: each new path with
   * the repository file it was moved from, `''` for a new, empty one.
   */
  added: Record<string, string>;
  /** Repository files deleted or moved away. */
  deleted: string[];
  /** New folders without files yet. */
  folders: string[];
}

export const NO_TREE_CHANGES: TreeChanges = {
  added: {},
  deleted: [],
  folders: [],
};

export type FileStatus = 'added' | 'deleted';

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/** Stored changes, checked. */
export function parseTreeChanges(data: unknown): TreeChanges | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const value = data as Record<string, unknown>;
  const added: Record<string, string> = {};
  if (typeof value.added === 'object' && value.added !== null) {
    for (const [path, source] of Object.entries(value.added)) {
      if (typeof source === 'string') {
        added[path] = source;
      }
    }
  }

  return {
    added,
    deleted: strings(value.deleted),
    folders: strings(value.folders),
  };
}

export function hasTreeChanges(changes: TreeChanges): boolean {
  return (
    Object.keys(changes.added).length > 0 ||
    changes.deleted.length > 0 ||
    changes.folders.length > 0
  );
}

/** `path` itself or anything below it. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** The folders a path is in, outermost first. */
export function parentsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * The tree as it is now: new and moved files added (with their folders),
 * deleted ones still listed so they can be restored, with each file's
 * status.
 */
export function changedTree(
  base: ReadonlyArray<TreeEntry>,
  changes: TreeChanges
): { entries: TreeEntry[]; status: Map<string, FileStatus> } {
  const status = new Map<string, FileStatus>();
  const deleted = new Set(changes.deleted);
  const entries = base.filter(
    (e) => !(e.type === 'file' && e.path in changes.added)
  );
  const dirs = new Set(
    entries.filter((e) => e.type === 'dir').map((e) => e.path)
  );
  const addDir = (dir: string): void => {
    if (!dirs.has(dir)) {
      dirs.add(dir);
      entries.push({ path: dir, type: 'dir' });
    }
  };

  for (const entry of entries) {
    if (entry.type === 'file' && deleted.has(entry.path)) {
      status.set(entry.path, 'deleted');
    }
  }

  for (const path of Object.keys(changes.added)) {
    parentsOf(path).forEach(addDir);
    entries.push({ path, type: 'file' });
    status.set(path, 'added');
  }

  for (const folder of changes.folders) {
    [...parentsOf(folder), folder].forEach(addDir);
  }

  return { entries, status };
}

/** The files there are now: the repository's without the deleted, plus new. */
export function currentFiles(
  base: ReadonlyArray<TreeEntry>,
  changes: TreeChanges
): Set<string> {
  const deleted = new Set(changes.deleted);
  const files = new Set(
    base
      .filter((e) => e.type === 'file' && !deleted.has(e.path))
      .map((e) => e.path)
  );
  for (const path of Object.keys(changes.added)) {
    files.add(path);
  }

  return files;
}

/**
 * What a path reads: `''` for a new file, the repository file a moved one
 * comes from, `undefined` for a repository file at its place.
 */
export function sourceOf(
  changes: TreeChanges,
  path: string
): string | undefined {
  return changes.added[path];
}

function clone(changes: TreeChanges): TreeChanges {
  return {
    added: { ...changes.added },
    deleted: [...changes.deleted],
    folders: [...changes.folders],
  };
}

/** Folders that hold a file now are no longer kept on their own. */
function withoutFilledFolders(changes: TreeChanges): TreeChanges {
  const files = Object.keys(changes.added);
  changes.folders = changes.folders.filter(
    (folder) => !files.some((path) => isWithin(path, folder))
  );
  return changes;
}

export function createFile(changes: TreeChanges, path: string): TreeChanges {
  const next = clone(changes);
  next.added[path] = '';
  return withoutFilledFolders(next);
}

export function createFolder(changes: TreeChanges, path: string): TreeChanges {
  const next = clone(changes);
  next.folders.push(path);
  return next;
}

/**
 * Moves a file or a folder (every file below it); `files` are the files
 * there are now.
 */
export function renamePath(
  changes: TreeChanges,
  files: ReadonlySet<string>,
  from: string,
  to: string
): TreeChanges {
  const next = clone(changes);
  const moved = (path: string): string => to + path.slice(from.length);
  for (const path of files) {
    if (!isWithin(path, from)) {
      continue;
    }

    const target = moved(path);
    const source = path in next.added ? (next.added[path] ?? '') : path;
    if (path in next.added) {
      delete next.added[path];
    } else {
      next.deleted.push(path);
    }

    if (source === target) {
      // Moved back to where it was: the repository file again.
      next.deleted = next.deleted.filter((p) => p !== target);
    } else {
      next.added[target] = source;
    }
  }

  next.folders = next.folders.map((folder) =>
    isWithin(folder, from) ? moved(folder) : folder
  );
  return withoutFilledFolders(next);
}

/** Deletes a file or a folder; `files` are the files there are now. */
export function removePath(
  changes: TreeChanges,
  files: ReadonlySet<string>,
  path: string
): TreeChanges {
  const next = clone(changes);
  for (const file of files) {
    if (!isWithin(file, path)) {
      continue;
    }

    // A moved file's original stays deleted.
    if (file in next.added) {
      delete next.added[file];
    } else {
      next.deleted.push(file);
    }
  }

  next.folders = next.folders.filter((folder) => !isWithin(folder, path));
  return next;
}

/** Brings back a deleted repository file (or every one in a folder). */
export function restorePath(changes: TreeChanges, path: string): TreeChanges {
  const next = clone(changes);
  next.deleted = next.deleted.filter(
    (file) => !isWithin(file, path) || file in next.added
  );
  return next;
}

/**
 * Why a new file or folder can't have this path, or `undefined`: `taken`
 * are the paths of files and folders there are now.
 */
export function pathError(
  taken: ReadonlySet<string>,
  path: string
): string | undefined {
  const parts = path.split('/');
  if (path.trim() === '' || parts.some((p) => p.trim() === '')) {
    return 'Give it a name.';
  }

  if (parts.some((p) => p === '.' || p === '..')) {
    return 'Names can’t be . or ..';
  }

  if (/[\\:*?"<>|]/.test(path)) {
    return 'Names can’t hold \\ : * ? " < > |';
  }

  if (taken.has(path)) {
    return `${parts.at(-1) ?? path} already exists here.`;
  }

  return undefined;
}
