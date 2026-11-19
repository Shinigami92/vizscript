import type { TreeEntry } from '@vizscript/api-contract';
import type { IgnoreMatcher } from './gitignore';
import { gitignoreMatcher } from './gitignore';

/** At most this many files and folders are listed. */
const MAX_ENTRIES = 20_000;

export interface FolderListing {
  entries: TreeEntry[];
  /** The folder has more entries than `MAX_ENTRIES`. */
  truncated: boolean;
}

/** A folder on this computer, opened in the browser. */
export interface LocalProject {
  id: string;
  name: string;
  /** Changes can be saved to disk (File System Access API). */
  canWrite: boolean;
  list(): Promise<FolderListing>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** Creates an empty file or a folder (folders on the way too). */
  create?(path: string, kind: 'file' | 'dir'): Promise<void>;
  /** Moves a file or a folder with everything in it. */
  rename?(from: string, to: string): Promise<void>;
  /** Deletes a file or a folder with everything in it. */
  remove?(path: string): Promise<void>;
}

/** Whether the browser can open folders with read and write access. */
export const canAccessFolders =
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

// ------------------------------------------------- folders by handle

async function readText(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<string | undefined> {
  try {
    return await (await fileHandle(root, path)).getFile().then((f) => f.text());
  } catch {
    return undefined;
  }
}

async function fileHandle(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemFileHandle> {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }

  return dir.getFileHandle(name);
}

/** The folder holding `path`, and the name in it. */
async function parentOf(
  root: FileSystemDirectoryHandle,
  path: string,
  create = false
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }

  return { dir, name };
}

/** The file or folder at a path, or `undefined`. */
async function entryAt(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemHandle | undefined> {
  try {
    const { dir, name } = await parentOf(root, path);
    for await (const [entry, handle] of dir.entries()) {
      if (entry === name) {
        return handle;
      }
    }
  } catch {
    // a folder on the way is missing
  }

  return undefined;
}

/** Copies a file or a folder into `dir` under `name`. */
async function copyInto(
  handle: FileSystemHandle,
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<void> {
  if (handle.kind === 'file') {
    const content = await (handle as FileSystemFileHandle).getFile();
    const writable = await (
      await dir.getFileHandle(name, { create: true })
    ).createWritable();
    await writable.write(content);
    await writable.close();
    return;
  }

  const target = await dir.getDirectoryHandle(name, { create: true });
  for await (const [child, childHandle] of (
    handle as FileSystemDirectoryHandle
  ).entries()) {
    await copyInto(childHandle, target, child);
  }
}

async function listHandle(
  root: FileSystemDirectoryHandle
): Promise<FolderListing> {
  const ignored = gitignoreMatcher((await readText(root, '.gitignore')) ?? '');
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function walk(
    dir: FileSystemDirectoryHandle,
    prefix: string
  ): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }

      const path = prefix ? `${prefix}/${name}` : name;
      const isDir = handle.kind === 'directory';
      if (ignored(path, isDir)) {
        continue;
      }

      entries.push({ path, type: isDir ? 'dir' : 'file' });
      if (isDir) {
        await walk(handle, path);
      }
    }
  }

  await walk(root, '');
  return { entries, truncated };
}

async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite'
): Promise<boolean> {
  if ((await handle.queryPermission({ mode })) === 'granted') {
    return true;
  }

  return (await handle.requestPermission({ mode })) === 'granted';
}

function handleProject(
  id: string,
  root: FileSystemDirectoryHandle
): LocalProject {
  const mayWrite = async (): Promise<void> => {
    if (!(await ensurePermission(root, 'readwrite'))) {
      throw new Error('No permission to change this folder.');
    }
  };

  return {
    id,
    name: root.name,
    canWrite: true,
    list: () => listHandle(root),
    read: async (path) =>
      (await fileHandle(root, path)).getFile().then((f) => f.text()),
    write: async (path, text) => {
      if (!(await ensurePermission(root, 'readwrite'))) {
        throw new Error('No permission to save into this folder.');
      }

      const writable = await (await fileHandle(root, path)).createWritable();
      await writable.write(text);
      await writable.close();
    },
    create: async (path, kind) => {
      await mayWrite();
      if (await entryAt(root, path)) {
        throw new Error(`${path} already exists.`);
      }

      const { dir, name } = await parentOf(root, path, true);
      await (kind === 'file'
        ? dir.getFileHandle(name, { create: true })
        : dir.getDirectoryHandle(name, { create: true }));
    },
    rename: async (from, to) => {
      await mayWrite();
      const handle = await entryAt(root, from);
      if (!handle) {
        throw new Error(`${from} is gone.`);
      }

      if (await entryAt(root, to)) {
        throw new Error(`${to} already exists.`);
      }

      // Copied, then removed: `move()` isn't there for every folder.
      const target = await parentOf(root, to, true);
      await copyInto(handle, target.dir, target.name);
      const source = await parentOf(root, from);
      await source.dir.removeEntry(source.name, { recursive: true });
    },
    remove: async (path) => {
      await mayWrite();
      const { dir, name } = await parentOf(root, path);
      await dir.removeEntry(name, { recursive: true });
    },
  };
}

// ------------------------------------- folders from <input webkitdirectory>

/**
 * Fallback for browsers without the File System Access API: the files are
 * read once and cannot be saved back. Lives only as long as the tab.
 */
export async function projectFromFiles(
  files: ReadonlyArray<File>
): Promise<LocalProject> {
  const first = files[0]?.webkitRelativePath ?? '';
  const name = first.split('/')[0] || 'folder';
  const byPath = new Map<string, File>();
  for (const file of files) {
    // `name/src/a.ts` → `src/a.ts`
    byPath.set(file.webkitRelativePath.split('/').slice(1).join('/'), file);
  }

  const gitignore = await byPath.get('.gitignore')?.text();
  const ignored: IgnoreMatcher = gitignoreMatcher(gitignore ?? '');
  const entries: TreeEntry[] = [];
  const dirs = new Set<string>();
  const skipped: string[] = [];
  for (const path of [...byPath.keys()].toSorted()) {
    const parts = path.split('/');
    let skip = skipped.some((dir) => path.startsWith(`${dir}/`));
    for (let i = 1; i < parts.length && !skip; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dirs.has(dir)) {
        continue;
      }

      if (ignored(dir, true)) {
        skipped.push(dir);
        skip = true;
      } else {
        dirs.add(dir);
        entries.push({ path: dir, type: 'dir' });
      }
    }

    if (!skip && !ignored(path, false)) {
      entries.push({ path, type: 'file' });
    }
  }

  const id = `tab-${crypto.randomUUID().slice(0, 8)}`;
  const project: LocalProject = {
    id,
    name,
    canWrite: false,
    list: async () => ({
      entries: entries.slice(0, MAX_ENTRIES),
      truncated: entries.length > MAX_ENTRIES,
    }),
    read: async (path) => {
      const file = byPath.get(path);
      if (!file) {
        throw new Error(`${path} is not in this folder.`);
      }

      return file.text();
    },
    write: () =>
      Promise.reject(
        new Error('This browser cannot save into folders. Use Chrome or Edge.')
      ),
  };
  tabProjects.set(id, project);
  return project;
}

// ------------------------------------------------ remembered folders

/** A folder opened before; its handle is kept in IndexedDB. */
export interface RememberedFolder {
  id: string;
  name: string;
  openedAt: number;
  handle: FileSystemDirectoryHandle;
}

const tabProjects = new Map<string, LocalProject>();

let opened: Promise<IDBDatabase> | undefined;

/**
 * The page's one connection to the folders database. It closes itself when
 * another tab upgrades the database, and the next use opens it again.
 */
function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('vizscript', 1);
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore('folders', { keyPath: 'id' });
    });
    request.addEventListener('success', () => {
      const db = request.result;
      db.addEventListener('versionchange', () => {
        db.close();
        opened = undefined;
      });
      db.addEventListener('close', () => {
        opened = undefined;
      });
      resolve(db);
    });
    request.addEventListener('blocked', () => {
      reject(
        new Error(
          'Another vizscript tab keeps the folder list open. Close or reload it.'
        )
      );
    });
    request.addEventListener('error', () => reject(request.error));
  });
  // A failed open is tried again next time.
  opened.catch(() => {
    opened = undefined;
  });
  return opened;
}

async function folders<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = run(db.transaction('folders', mode).objectStore('folders'));
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
}

/** Folders opened before, most recent first. */
export async function rememberedFolders(): Promise<RememberedFolder[]> {
  const all = await folders<RememberedFolder[]>('readonly', (s) => s.getAll());
  return all.toSorted((a, b) => b.openedAt - a.openedAt);
}

export async function forgetFolder(id: string): Promise<void> {
  tabProjects.delete(id);
  await folders('readwrite', (s) => s.delete(id));
}

/**
 * Lets the user pick a folder and remembers it. Picking a folder again
 * keeps its id, so its layouts and drafts stay.
 */
export async function pickFolder(): Promise<LocalProject> {
  const handle = await window.showDirectoryPicker({
    id: 'vizscript',
    mode: 'read',
  });
  const known = await rememberedFolders();
  let id: string | undefined;
  for (const folder of known) {
    if (await folder.handle.isSameEntry(handle)) {
      id = folder.id;
      break;
    }
  }

  id ??= crypto.randomUUID().slice(0, 8);
  const record: RememberedFolder = {
    id,
    name: handle.name,
    openedAt: Date.now(),
    handle,
  };
  await folders('readwrite', (s) => s.put(record));
  const project = handleProject(id, handle);
  tabProjects.set(id, project);
  return project;
}

export type OpenResult =
  | { status: 'ready'; project: LocalProject }
  /** Remembered, but the browser needs a click to grant access again. */
  | { status: 'permission'; name: string; grant: () => Promise<LocalProject> }
  | { status: 'missing' };

/** The project of an id from the URL. */
export async function openProject(id: string): Promise<OpenResult> {
  const open = tabProjects.get(id);
  if (open) {
    return { status: 'ready', project: open };
  }

  const record = await folders<RememberedFolder | undefined>('readonly', (s) =>
    s.get(id)
  ).catch(() => undefined);
  if (!record || !canAccessFolders) {
    return { status: 'missing' };
  }

  const ready = (): LocalProject => {
    const project = handleProject(id, record.handle);
    tabProjects.set(id, project);
    void folders('readwrite', (s) =>
      s.put({ ...record, openedAt: Date.now() })
    );
    return project;
  };

  if ((await record.handle.queryPermission({ mode: 'read' })) === 'granted') {
    return { status: 'ready', project: ready() };
  }

  return {
    status: 'permission',
    name: record.name,
    grant: async () => {
      if (!(await ensurePermission(record.handle, 'read'))) {
        throw new Error(`No permission to open ${record.name}.`);
      }

      return ready();
    },
  };
}
