import type { GraphOverlay } from '@vizscript/core';
import { EMPTY_OVERLAY } from '@vizscript/core';
import { tryOnBeforeUnmount, useDebounceFn } from '@vueuse/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, ref, shallowReactive, shallowRef, watch } from 'vue';
import { isWithin } from '../graph/tree-changes';
import type { KeyValueStorage } from '../storage/browser-storage';
import {
  readStored,
  removeStored,
  writeStored,
} from '../storage/browser-storage';
import { trackTask } from './use-background-tasks';
import type { FileTabs } from './use-file-tabs';
import { useFileTabs } from './use-file-tabs';

/** A file as read: its text and what identifies that version of it. */
export interface LoadedFile {
  path: string;
  content: string;
  /** The version the text belongs to: a blob sha, or the content itself. */
  version: string;
}

interface Buffer {
  file: LoadedFile;
  text: string;
  overlay: GraphOverlay;
}

/** A file's unsaved changes, kept in the browser until saved. */
interface Draft {
  version: string;
  text: string;
  overlay?: GraphOverlay;
  /** Local drafts written before versions: the whole file text. */
  legacyBase?: string;
}

/** Unsaved edits made on an older version of the file than the one read. */
export interface OutdatedDraft {
  path: string;
  text: string;
}

function isOverlay(value: unknown): value is GraphOverlay {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as GraphOverlay).edits)
  );
}

/**
 * A stored draft, checked; also drafts written before the shared session
 * (`sha` of repositories, the whole `base` text of local files).
 */
function parseDraft(data: unknown): Draft | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const value = data as Record<string, unknown>;
  const version = [value.version, value.sha].find(
    (v): v is string => typeof v === 'string'
  );
  const legacyBase = typeof value.base === 'string' ? value.base : undefined;
  if (
    typeof value.text !== 'string' ||
    (!version && legacyBase === undefined)
  ) {
    return null;
  }

  return {
    version: version ?? '',
    text: value.text,
    // Graph-only edits of another format are dropped, the text stays.
    ...(isOverlay(value.overlay) ? { overlay: value.overlay } : {}),
    ...(legacyBase === undefined ? {} : { legacyBase }),
  };
}

export interface FileSessionOptions {
  /**
   * The repository branch or folder (`github/o/r@main`, `local/<id>`): its
   * tabs, drafts and loaded files belong to it.
   */
  scope: Ref<string>;
  /** The file of the URL. */
  path: Ref<string>;
  /** Whether `path` is a file of the loaded tree (else nothing is shown). */
  isFile: Ref<boolean>;
  read: (path: string) => Promise<LoadedFile>;
  /** Whether unsaved changes are kept in the browser (default: yes). */
  persistDrafts?: () => boolean;
  /** Frees what an editor kept for a file of `scope` (its Monaco model). */
  dispose: (path: string, scope: string) => void;
  /** Shown when a draft was restored. */
  onRestored?: () => void;
  /** The browser's storage; tests pass their own. */
  storage?: KeyValueStorage;
}

export interface FileSession {
  /** The file on screen; it changes once the next one has been read. */
  file: ShallowRef<LoadedFile | null>;
  text: Ref<string>;
  /** Graph-only edits of the open file (the graph not in sync). */
  overlay: ShallowRef<GraphOverlay>;
  /** The open file has unsaved changes. */
  dirty: ComputedRef<boolean>;
  loadingFile: Ref<boolean>;
  fileError: Ref<string | null>;
  tabs: FileTabs;
  /** Tabs with unsaved changes (also not loaded ones with a draft). */
  dirtyTabs: ComputedRef<Set<string>>;
  /**
   * Every file of the scope with unsaved changes: open ones and those with
   * a draft in the browser (the explorer marks them, like VS Code).
   */
  changedFiles: ComputedRef<Set<string>>;
  /** The current text of an open tab, if it is one. */
  openText: (path: string) => string | undefined;
  /** Reads the file of the URL (from its tab when it is open). */
  loadFile: () => Promise<void>;
  /** Closes a tab; returns the file to show next when it was on screen. */
  closeTab: (path: string) => string | null | undefined;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  /** Drops the open file's changes (the caller asks first). */
  discard: () => void;
  /**
   * Unsaved edits of the open file made on an older version of it: kept
   * aside until the user restores or drops them.
   */
  outdated: ShallowRef<OutdatedDraft | null>;
  /** Puts the outdated edits into the editor (on top of the new version). */
  restoreOutdated: () => void;
  dropOutdated: () => void;
  /**
   * `path` was written with `content`: its new base; changes made while it
   * was written stay as a draft.
   */
  markSaved: (path: string, content: string, version: string) => void;
  /** The open file changed elsewhere and has no changes here: show it. */
  replaceShown: (file: LoadedFile) => void;
  /**
   * Changes another file of the session (a manifest when a library is
   * added): its unsaved text, or its content with its draft, gets `edit`;
   * it opens as a tab with unsaved changes. Resolves whether it changed.
   */
  editFile: (path: string, edit: (text: string) => string) => Promise<boolean>;
  /**
   * A file or folder was renamed: tabs, unsaved text and drafts of the
   * files move along. The caller shows the moved file when it was on
   * screen.
   */
  movePath: (from: string, to: string) => void;
  /** A file or folder was deleted: its tabs, unsaved text and drafts go. */
  forgetPath: (path: string) => void;
}

/**
 * The open files of a repository branch or local folder: the file on
 * screen, its tabs with their unsaved text, and drafts kept in the browser
 * (RepoView and LocalProjectView).
 */
export function useFileSession(options: FileSessionOptions): FileSession {
  const storage = (): KeyValueStorage | undefined =>
    options.storage ?? globalThis.localStorage;
  const persist = (): boolean => options.persistDrafts?.() ?? true;

  const file = shallowRef<LoadedFile | null>(null);
  const outdated = shallowRef<OutdatedDraft | null>(null);
  const text = ref('');
  const overlay = shallowRef<GraphOverlay>(EMPTY_OVERLAY);
  const loadingFile = ref(false);
  const fileError = ref<string | null>(null);

  const tabs = useFileTabs(
    computed(() => `vizscript:tabs:${options.scope.value}`)
  );
  const buffers = shallowReactive(new Map<string, Buffer>());

  function draftKey(path: string): string {
    return `vizscript:draft:${options.scope.value}:${path}`;
  }

  /** Where outdated edits wait for the user's choice. */
  function outdatedKey(path: string): string {
    return `${draftKey(path)}#outdated`;
  }

  function readDraft(path: string): Draft | null {
    return readStored(draftKey(path), parseDraft, storage());
  }

  /** Bumped when a draft is written or removed: storage is read again. */
  const draftsChanged = ref(0);

  function writeDraft(path: string, buffer: Buffer): void {
    draftsChanged.value++;
    if (
      persist() &&
      (buffer.text !== buffer.file.content || buffer.overlay.edits.length > 0)
    ) {
      writeStored(
        draftKey(path),
        {
          version: buffer.file.version,
          text: buffer.text,
          overlay: buffer.overlay,
        },
        storage()
      );
    } else {
      removeStored(draftKey(path), storage());
    }
  }

  const changedFiles = computed(() => {
    // Read for its dependency: drafts were written or removed.
    void draftsChanged.value;
    const result = new Set<string>();
    const store = persist() ? storage() : undefined;
    const prefix = draftKey('');
    for (let i = 0; i < (store?.length ?? 0); i++) {
      const key = store?.key(i);
      if (key?.startsWith(prefix) && !key.endsWith('#outdated')) {
        result.add(key.slice(prefix.length));
      }
    }

    for (const [path, buffer] of buffers) {
      if (isDirty(buffer)) {
        result.add(path);
      } else {
        result.delete(path);
      }
    }

    return result;
  });

  function isDirty(buffer: Buffer): boolean {
    return (
      buffer.text !== buffer.file.content || buffer.overlay.edits.length > 0
    );
  }

  const dirty = computed(
    () =>
      file.value !== null &&
      (text.value !== file.value.content || overlay.value.edits.length > 0)
  );

  const dirtyTabs = computed(() => {
    const result = new Set<string>();
    for (const tab of tabs.tabs.value) {
      const buffer = buffers.get(tab.path);
      if (buffer ? isDirty(buffer) : readDraft(tab.path) !== null) {
        result.add(tab.path);
      }
    }

    return result;
  });

  function forget(paths: Iterable<string>, scope = options.scope.value): void {
    for (const path of paths) {
      buffers.delete(path);
      options.dispose(path, scope);
    }
  }

  // Another branch or folder has other files: start fresh.
  watch(options.scope, (_, previous) => forget(buffers.keys(), previous));
  // Leaving the view: the editor state of its tabs goes (their buffers
  // still write their drafts).
  tryOnBeforeUnmount(() => {
    for (const tab of tabs.tabs.value) {
      options.dispose(tab.path, options.scope.value);
    }
  });

  let fileRequest = 0;

  async function loadFile(): Promise<void> {
    const request = ++fileRequest;
    const previous = file.value?.path;
    fileError.value = null;
    if (!options.isFile.value) {
      file.value = null;
      outdated.value = null;
      loadingFile.value = false;
      return;
    }

    const next = options.path.value;
    const cached = buffers.get(next);
    if (cached) {
      // An open tab: instant, with its unsaved changes.
      outdated.value = persist() ? outdatedOf(next) : null;
      text.value = cached.text;
      overlay.value = cached.overlay;
      file.value = cached.file;
      tabs.open(next, { after: previous });
      loadingFile.value = false;
      return;
    }

    loadingFile.value = true;
    try {
      const loaded = await trackTask(
        `Opening ${next.split('/').at(-1) ?? next}`,
        options.read(next)
      );
      if (request !== fileRequest) {
        return;
      }

      let initial = loaded.content;
      let initialOverlay = EMPTY_OVERLAY;
      const draft = persist() ? readDraft(loaded.path) : null;
      const changed =
        draft !== null &&
        (draft.text !== loaded.content ||
          (draft.overlay?.edits.length ?? 0) > 0);
      const sameVersion =
        draft !== null &&
        (draft.legacyBase === undefined
          ? // Local drafts once kept the whole text as their version.
            draft.version === loaded.version || draft.version === loaded.content
          : draft.legacyBase === loaded.content);
      if (draft && changed && sameVersion) {
        initial = draft.text;
        initialOverlay = draft.overlay ?? EMPTY_OVERLAY;
        options.onRestored?.();
      } else if (draft && changed) {
        // Edits of an older version of the file: kept aside, offered.
        writeStored(
          outdatedKey(loaded.path),
          { version: draft.version, text: draft.text },
          storage()
        );
        removeStored(draftKey(loaded.path), storage());
        draftsChanged.value++;
      }

      outdated.value = persist() ? outdatedOf(loaded.path) : null;

      // All at once: the workspace of the new file gets the new text.
      text.value = initial;
      overlay.value = initialOverlay;
      file.value = loaded;
      buffers.set(loaded.path, {
        file: loaded,
        text: initial,
        overlay: initialOverlay,
      });
      tabs.open(loaded.path, { after: previous });
    } catch (error) {
      if (request === fileRequest) {
        file.value = null;
        fileError.value = (error as Error).message;
      }
    } finally {
      if (request === fileRequest) {
        loadingFile.value = false;
      }
    }
  }

  // Every file changed since the last write gets its draft, also when
  // another tab is shown by then.
  const pending = new Set<string>();
  const flushDrafts = useDebounceFn(() => {
    for (const path of pending) {
      const buffer = buffers.get(path);
      if (buffer) {
        writeDraft(path, buffer);
      }
    }

    pending.clear();
  }, 500);

  // The open tab keeps its text; the draft follows.
  watch([text, overlay], ([value, edits]) => {
    const shown = file.value;
    if (shown) {
      buffers.set(shown.path, { file: shown, text: value, overlay: edits });
      pending.add(shown.path);
      void flushDrafts();
    }
  });

  // Editing a file keeps its tab open, like VS Code.
  watch(
    () => dirtyTabs.value.has(file.value?.path ?? ''),
    (isDirtyNow) => {
      if (isDirtyNow && file.value) {
        tabs.pin(file.value.path);
      }
    }
  );

  function closeTab(path: string): string | null | undefined {
    const shown = file.value?.path ?? null;
    const next = tabs.close(path, shown);
    forget([path]);
    return path === shown ? next : undefined;
  }

  function closeOtherTabs(path: string): void {
    forget(tabs.tabs.value.map((t) => t.path).filter((p) => p !== path));
    tabs.closeOthers(path);
  }

  function closeAllTabs(): void {
    forget(tabs.tabs.value.map((t) => t.path));
    tabs.closeAll();
  }

  function discard(): void {
    const shown = file.value;
    if (shown) {
      text.value = shown.content;
      overlay.value = EMPTY_OVERLAY;
      removeStored(draftKey(shown.path), storage());
      draftsChanged.value++;
    }
  }

  function outdatedOf(path: string): OutdatedDraft | null {
    const stored = readStored(outdatedKey(path), parseDraft, storage());
    return stored ? { path, text: stored.text } : null;
  }

  function restoreOutdated(): void {
    const edits = outdated.value;
    if (edits && file.value?.path === edits.path) {
      // Its graph-only edits belonged to the old version's nodes: the text
      // comes back, on top of the new version.
      text.value = edits.text;
      overlay.value = EMPTY_OVERLAY;
      dropOutdated();
    }
  }

  function dropOutdated(): void {
    const edits = outdated.value;
    if (edits) {
      removeStored(outdatedKey(edits.path), storage());
      outdated.value = null;
    }
  }

  function markSaved(path: string, content: string, version: string): void {
    const saved: LoadedFile = { path, content, version };
    const buffer = buffers.get(path);
    const next: Buffer = buffer
      ? { ...buffer, file: saved }
      : { file: saved, text: content, overlay: EMPTY_OVERLAY };
    buffers.set(path, next);
    if (file.value?.path === path) {
      file.value = saved;
    }

    writeDraft(path, next);
  }

  function replaceShown(next: LoadedFile): void {
    text.value = next.content;
    overlay.value = EMPTY_OVERLAY;
    file.value = next;
    buffers.set(next.path, {
      file: next,
      text: next.content,
      overlay: EMPTY_OVERLAY,
    });
  }

  async function editFile(
    path: string,
    edit: (text: string) => string
  ): Promise<boolean> {
    if (file.value?.path === path) {
      const next = edit(text.value);
      const changed = next !== text.value;
      text.value = next;
      return changed;
    }

    let buffer = buffers.get(path);
    if (!buffer) {
      const loaded = await options.read(path);
      const draft = persist() ? readDraft(path) : null;
      const current =
        draft && draft.version === loaded.version ? draft.text : loaded.content;
      buffer = {
        file: loaded,
        text: current,
        overlay: draft?.overlay ?? EMPTY_OVERLAY,
      };
    }

    const next = edit(buffer.text);
    if (next === buffer.text) {
      return false;
    }

    const changed = { ...buffer, text: next };
    buffers.set(path, changed);
    writeDraft(path, changed);
    tabs.open(path, { preview: false, after: file.value?.path });
    return true;
  }

  /** Draft keys of the scope's files within `folder`. */
  function storedWithin(folder: string): string[] {
    const store = storage();
    const prefix = draftKey('');
    const keys: string[] = [];
    for (let i = 0; i < (store?.length ?? 0); i++) {
      const key = store?.key(i);
      const path = key?.startsWith(prefix)
        ? key.slice(prefix.length).replace(/#outdated$/, '')
        : undefined;
      if (key && path !== undefined && isWithin(path, folder)) {
        keys.push(key);
      }
    }

    return keys;
  }

  function movePath(from: string, to: string): void {
    const moved = (path: string): string | undefined =>
      isWithin(path, from) ? to + path.slice(from.length) : undefined;
    for (const [path, buffer] of Array.from(buffers)) {
      const target = moved(path);
      if (target !== undefined) {
        buffers.delete(path);
        options.dispose(path, options.scope.value);
        buffers.set(target, {
          ...buffer,
          file: { ...buffer.file, path: target },
        });
        // A draft still to write goes to the new path.
        if (pending.delete(path)) {
          pending.add(target);
        }
      }
    }

    const store = storage();
    const prefix = draftKey('');
    for (const key of storedWithin(from)) {
      const raw = store?.getItem(key);
      const target = moved(key.slice(prefix.length).replace(/#outdated$/, ''));
      if (raw !== null && raw !== undefined && target !== undefined) {
        store?.setItem(
          key.endsWith('#outdated') ? outdatedKey(target) : draftKey(target),
          raw
        );
        removeStored(key, store);
      }
    }

    tabs.rename(moved);
    const shown = file.value;
    if (shown && moved(shown.path) !== undefined) {
      // The next load shows it from its buffer, under the new path.
      file.value = null;
    }

    draftsChanged.value++;
  }

  function forgetPath(path: string): void {
    for (const open of Array.from(buffers.keys())) {
      if (isWithin(open, path)) {
        buffers.delete(open);
        options.dispose(open, options.scope.value);
      }
    }

    for (const key of storedWithin(path)) {
      removeStored(key, storage());
    }

    tabs.remove((tab) => isWithin(tab, path));
    if (file.value && isWithin(file.value.path, path)) {
      file.value = null;
    }

    draftsChanged.value++;
  }

  return {
    editFile,
    movePath,
    forgetPath,
    file,
    text,
    overlay,
    dirty,
    loadingFile,
    fileError,
    tabs,
    dirtyTabs,
    changedFiles,
    openText: (path) => buffers.get(path)?.text,
    loadFile,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    discard,
    outdated,
    restoreOutdated,
    dropOutdated,
    markSaved,
    replaceShown,
  };
}
