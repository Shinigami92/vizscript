import type { Ref } from 'vue';
import { ref, watch } from 'vue';

/** An open file, like a VS Code editor tab. */
export interface FileTab {
  path: string;
  /**
   * A preview tab (italic) is replaced by the next file opened the same
   * way; double-click or editing keeps it.
   */
  preview: boolean;
}

export interface FileTabs {
  tabs: Ref<FileTab[]>;
  /** Opens a file; `preview` replaces the current preview tab. */
  open: (path: string, options?: { preview?: boolean; after?: string }) => void;
  /** Keeps a preview tab open. */
  pin: (path: string) => void;
  /** Closes a tab and returns the tab to show next (if it was active). */
  close: (path: string, active: string | null) => string | null;
  closeOthers: (path: string) => void;
  closeAll: () => void;
  /** Moves a tab to another position. */
  move: (path: string, index: number) => void;
}

function read(key: string): FileTab[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(value)
      ? value.filter(
          (t): t is FileTab =>
            typeof t === 'object' &&
            t !== null &&
            typeof (t as FileTab).path === 'string'
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Open files of a repository branch or local folder, remembered in the
 * browser (`key`), like VS Code's open editors.
 */
export function useFileTabs(key: Ref<string>): FileTabs {
  const tabs = ref<FileTab[]>(read(key.value));

  watch(key, (next) => {
    tabs.value = read(next);
  });

  watch(
    tabs,
    (value) => {
      try {
        localStorage.setItem(key.value, JSON.stringify(value));
      } catch {
        // storage full or unavailable: tabs stay for this visit
      }
    },
    { deep: true }
  );

  function open(
    path: string,
    options: { preview?: boolean; after?: string } = {}
  ): void {
    const preview = options.preview ?? true;
    const existing = tabs.value.find((t) => t.path === path);
    if (existing) {
      if (!preview) {
        existing.preview = false;
      }

      return;
    }

    const tab = { path, preview };
    const previewIndex = tabs.value.findIndex((t) => t.preview);
    if (preview && previewIndex !== -1) {
      tabs.value.splice(previewIndex, 1, tab);
      return;
    }

    const after = tabs.value.findIndex((t) => t.path === options.after);
    tabs.value.splice(after === -1 ? tabs.value.length : after + 1, 0, tab);
  }

  function pin(path: string): void {
    const tab = tabs.value.find((t) => t.path === path);
    if (tab) {
      tab.preview = false;
    }
  }

  function close(path: string, active: string | null): string | null {
    const index = tabs.value.findIndex((t) => t.path === path);
    if (index === -1) {
      return active;
    }

    tabs.value.splice(index, 1);
    if (path !== active) {
      return active;
    }

    // Like VS Code: the tab to the right, else the one to the left.
    return (tabs.value[index] ?? tabs.value[index - 1])?.path ?? null;
  }

  function closeOthers(path: string): void {
    tabs.value = tabs.value.filter((t) => t.path === path);
  }

  function closeAll(): void {
    tabs.value = [];
  }

  function move(path: string, index: number): void {
    const from = tabs.value.findIndex((t) => t.path === path);
    if (from === -1 || from === index) {
      return;
    }

    const [tab] = tabs.value.splice(from, 1);
    if (tab) {
      tabs.value.splice(Math.min(index, tabs.value.length), 0, tab);
    }
  }

  return { tabs, open, pin, close, closeOthers, closeAll, move };
}
