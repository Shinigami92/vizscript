import type { GraphOverlay } from '@vizscript/core';
import { EMPTY_OVERLAY } from '@vizscript/core';
import { useDebounceFn } from '@vueuse/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, ref, shallowReactive, shallowRef, watch } from 'vue';
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
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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
  /** Frees what an editor kept for a file (its Monaco model). */
  dispose: (path: string) => void;
  /** Shown when a draft was restored. */
  onRestored?: () => void;
  /** The browser's storage; tests pass their own. */
  storage?: DraftStorage;
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
   * `path` was written with `content`: its new base; changes made while it
   * was written stay as a draft.
   */
  markSaved: (path: string, content: string, version?: string) => void;
  /** The open file changed elsewhere and has no changes here: show it. */
  replaceShown: (file: LoadedFile) => void;
}

function draftOf(raw: string | null): Draft | null {
  const value = JSON.parse(raw ?? 'null') as
    | (Partial<Draft> & { sha?: string; base?: string })
    | null;
  // Drafts written before the shared session: `sha` (repositories) or the
  // whole `base` text (local folders).
  const version = value?.version ?? value?.sha ?? value?.base;
  return value && typeof value.text === 'string' && version !== undefined
    ? {
        version,
        text: value.text,
        ...(value.overlay ? { overlay: value.overlay } : {}),
      }
    : null;
}

/**
 * The open files of a repository branch or local folder: the file on
 * screen, its tabs with their unsaved text, and drafts kept in the browser
 * (RepoView and LocalProjectView).
 */
export function useFileSession(options: FileSessionOptions): FileSession {
  const storage = (): DraftStorage | undefined =>
    options.storage ?? globalThis.localStorage;
  const persist = (): boolean => options.persistDrafts?.() ?? true;

  const file = shallowRef<LoadedFile | null>(null);
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

  function readDraft(path: string): Draft | null {
    try {
      return draftOf(storage()?.getItem(draftKey(path)) ?? null);
    } catch {
      return null;
    }
  }

  function writeDraft(path: string, buffer: Buffer): void {
    try {
      if (
        persist() &&
        (buffer.text !== buffer.file.content || buffer.overlay.edits.length > 0)
      ) {
        const draft: Draft = {
          version: buffer.file.version,
          text: buffer.text,
          overlay: buffer.overlay,
        };
        storage()?.setItem(draftKey(path), JSON.stringify(draft));
      } else {
        storage()?.removeItem(draftKey(path));
      }
    } catch {
      // storage full or unavailable: the changes stay for this visit
    }
  }

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

  function forget(paths: Iterable<string>): void {
    for (const path of paths) {
      buffers.delete(path);
      options.dispose(path);
    }
  }

  // Another branch or folder has other files: start fresh.
  watch(options.scope, () => forget(buffers.keys()));

  let fileRequest = 0;

  async function loadFile(): Promise<void> {
    const request = ++fileRequest;
    const previous = file.value?.path;
    fileError.value = null;
    if (!options.isFile.value) {
      file.value = null;
      loadingFile.value = false;
      return;
    }

    const next = options.path.value;
    const cached = buffers.get(next);
    if (cached) {
      // An open tab: instant, with its unsaved changes.
      text.value = cached.text;
      overlay.value = cached.overlay;
      file.value = cached.file;
      tabs.open(next, { after: previous });
      loadingFile.value = false;
      return;
    }

    loadingFile.value = true;
    try {
      const loaded = await options.read(next);
      if (request !== fileRequest) {
        return;
      }

      let initial = loaded.content;
      let initialOverlay = EMPTY_OVERLAY;
      const draft = persist() ? readDraft(loaded.path) : null;
      if (
        draft?.version === loaded.version &&
        (draft.text !== loaded.content ||
          (draft.overlay?.edits.length ?? 0) > 0)
      ) {
        initial = draft.text;
        initialOverlay = draft.overlay ?? EMPTY_OVERLAY;
        options.onRestored?.();
      }

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
      try {
        storage()?.removeItem(draftKey(shown.path));
      } catch {
        // storage unavailable
      }
    }
  }

  function markSaved(path: string, content: string, version = content): void {
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

  return {
    file,
    text,
    overlay,
    dirty,
    loadingFile,
    fileError,
    tabs,
    dirtyTabs,
    openText: (path) => buffers.get(path)?.text,
    loadFile,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    discard,
    markSaved,
    replaceShown,
  };
}
