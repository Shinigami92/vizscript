import type { GraphOverlay } from '@vizscript/core';
import type { LayoutStore } from '../../graph/layout-store';
import type CodeEditor from '../CodeEditor.vue';
import type GraphCanvas from '../GraphCanvas.vue';

export interface ScriptWorkspaceProps {
  path: string;
  text: string;
  layoutStore: LayoutStore | null;
  /** Key for per-file view state (camera) in localStorage. */
  stateKey: string;
  /** Paths of the repository's files: imports of them open on Cmd+click. */
  files?: ReadonlySet<string>;
  /**
   * Reads another file of the repository (with unsaved changes), so
   * imported names get their declarations: call pins, types.
   */
  readFile?: (path: string) => Promise<string>;
  /**
   * The saved version of the file (last commit, file on disk, original
   * sample): Details offers to reset values to it (UE's ↶).
   */
  baseText?: string;
  /** Hide the share button (e.g. local folders, which have no shareable URL). */
  hideShare?: boolean;
  /** The file is open in a tab: keep its editor state when switching. */
  keepEditor?: boolean;
  /** Graph-only edits of the file (from its draft), `v-model:overlay`. */
  overlay?: GraphOverlay;
}

export type CodeEditorInstance = InstanceType<typeof CodeEditor>;
export type GraphCanvasInstance = InstanceType<typeof GraphCanvas>;

/** State of the Code / Split / Viz quick switch. */
export type ViewMode = 'code' | 'split' | 'viz';
