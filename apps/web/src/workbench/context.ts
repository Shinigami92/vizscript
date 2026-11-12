import type { ViewId } from '@vizscript/workbench';
import type { InjectionKey, Ref } from 'vue';

/**
 * Connects `WorkbenchView`s (the content) with the places the `Workbench`
 * renders for them. Content is teleported into those places, so moving a
 * view between zones moves its DOM instead of re-creating it: the code
 * editor keeps its undo history and the graph its camera.
 */
export interface WorkbenchContext {
  register: (view: ViewId) => () => void;
  /** Element the view's content should live in. */
  target: (view: ViewId) => HTMLElement | null;
  /** Stable function ref that records the place of a view. */
  placeRef: (view: ViewId) => (el: unknown) => void;
  ready: Ref<boolean>;
}

export const WORKBENCH: InjectionKey<WorkbenchContext> = Symbol('workbench');

export const VIEW_ICONS: Record<ViewId, string> = {
  explorer: 'i-mdi-file-tree-outline',
  script: 'i-mdi-format-list-bulleted-type',
  code: 'i-mdi-code-tags',
  graph: 'i-mdi-graph-outline',
  preview: 'i-mdi-eye-outline',
  details: 'i-mdi-card-text-outline',
  problems: 'i-mdi-alert-circle-outline',
};

export const DRAG_MIME = 'application/x-vizscript-view';
