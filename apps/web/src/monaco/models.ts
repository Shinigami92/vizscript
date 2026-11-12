import { monaco } from './setup';

/**
 * Editor state of open tabs: their Monaco models stay alive (with their
 * undo history), and the scroll position and cursor are restored.
 */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>();

export function modelUri(path: string): monaco.Uri {
  return monaco.Uri.parse(`file:///${path.replace(/^\/+/, '')}`);
}

export function saveViewState(
  path: string,
  state: monaco.editor.ICodeEditorViewState | null
): void {
  if (state) {
    viewStates.set(path, state);
  }
}

export function viewStateOf(
  path: string
): monaco.editor.ICodeEditorViewState | undefined {
  return viewStates.get(path);
}

/** Forgets a closed tab: its model, undo history and view state. */
export function disposeModel(path: string): void {
  monaco.editor.getModel(modelUri(path))?.dispose();
  viewStates.delete(path);
}
