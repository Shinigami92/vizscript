import { ModelScopes } from './model-scopes';
import { monaco } from './setup';

/**
 * Editor state of open tabs: their Monaco models stay alive (with their
 * undo history), and the scroll position and cursor are restored, within
 * the branch or folder they were opened in.
 */
const scopes = new ModelScopes<monaco.editor.ICodeEditorViewState>();

export function modelUri(path: string): monaco.Uri {
  return monaco.Uri.parse(`file:///${path.replace(/^\/+/, '')}`);
}

/**
 * The kept model of `path` when it belongs to `scope`; a model of the same
 * path from another scope is disposed.
 */
export function keptModel(
  path: string,
  scope: string
): monaco.editor.ITextModel | undefined {
  const model = monaco.editor.getModel(modelUri(path)) ?? undefined;
  if (model && scopes.owns(path, scope)) {
    return model;
  }

  model?.dispose();
  scopes.release(path);
  return undefined;
}

/** The model of `path` is kept for `scope`. */
export function keepModel(path: string, scope: string): void {
  scopes.claim(path, scope);
}

export function saveViewState(
  path: string,
  scope: string,
  state: monaco.editor.ICodeEditorViewState | null
): void {
  if (state) {
    scopes.saveView(path, scope, state);
  }
}

export function viewStateOf(
  path: string,
  scope: string
): monaco.editor.ICodeEditorViewState | undefined {
  return scopes.viewOf(path, scope);
}

/**
 * Forgets a closed tab: its model, undo history and view state; with
 * `scope`, only if the model still belongs to it.
 */
export function disposeModel(path: string, scope?: string): void {
  if (scopes.release(path, scope)) {
    monaco.editor.getModel(modelUri(path))?.dispose();
  }
}
