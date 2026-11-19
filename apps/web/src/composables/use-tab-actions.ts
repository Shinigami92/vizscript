import type { Ref } from 'vue';
import type { FileSession } from './use-file-session';

export interface TabActions {
  /** Closes a tab; shows the next one, or the folder after the last. */
  closeTab: (path: string) => void;
  /** Keeps only `path` open, and shows it. */
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  /** Double-click in the explorer: open in a tab that stays. */
  pinFile: (path: string) => void;
}

/**
 * The tab bar's and the explorer's actions on the open files of a file
 * session (RepoView and LocalProjectView), with the view's navigation.
 */
export function useTabActions(
  session: Pick<
    FileSession,
    'file' | 'tabs' | 'closeTab' | 'closeOtherTabs' | 'closeAllTabs'
  >,
  view: {
    /** The file of the URL. */
    path: Ref<string>;
    selectFile: (path: string) => void;
    /** Shows the folder (no file), when the last tab closed. */
    showNoFile: () => void;
  }
): TabActions {
  return {
    closeTab: (path) => {
      const next = session.closeTab(path);
      if (next === undefined) {
        return;
      }

      if (next) {
        view.selectFile(next);
      } else {
        view.showNoFile();
      }
    },
    closeOtherTabs: (path) => {
      session.closeOtherTabs(path);
      if (path !== session.file.value?.path) {
        view.selectFile(path);
      }
    },
    closeAllTabs: () => {
      session.closeAllTabs();
      view.showNoFile();
    },
    pinFile: (path) => {
      session.tabs.open(path, { preview: false });
      if (path !== view.path.value) {
        view.selectFile(path);
      }
    },
  };
}
