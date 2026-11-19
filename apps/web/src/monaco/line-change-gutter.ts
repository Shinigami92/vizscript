import type { LineChange } from '../graph/line-changes';
import { lineChanges } from '../graph/line-changes';
import { monaco } from './setup';

const GUTTER: Record<LineChange['kind'], string> = {
  added: 'line-change-added',
  modified: 'line-change-modified',
  deleted: 'line-change-deleted',
};

/** The scroll bar's marks, in the theme's colors for them. */
const RULER: Record<LineChange['kind'], { id: string }> = {
  added: { id: 'editorOverviewRuler.addedForeground' },
  modified: { id: 'editorOverviewRuler.modifiedForeground' },
  deleted: { id: 'editorOverviewRuler.deletedForeground' },
};

export interface LineChangeGutter {
  /** Compares again (after an edit, or a new saved version). */
  update: () => void;
  dispose: () => void;
}

/**
 * Marks the lines changed against the saved text in the editor's gutter
 * and scroll bar, like VS Code: added, modified, and where lines were
 * deleted. Without a saved text (the playground) nothing is marked.
 */
export function lineChangeGutter(
  editor: monaco.editor.IStandaloneCodeEditor,
  base: () => string | undefined
): LineChangeGutter {
  const decorations = editor.createDecorationsCollection();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const render = (): void => {
    timer = undefined;
    const model = editor.getModel();
    const saved = base();
    if (!model || model.isDisposed() || saved === undefined) {
      decorations.clear();
      return;
    }

    decorations.set(
      lineChanges(saved, model.getValue()).map((change) => ({
        range: new monaco.Range(change.start, 1, change.end, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: GUTTER[change.kind],
          overviewRuler: {
            color: RULER[change.kind],
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      }))
    );
  };

  render();
  return {
    update: (): void => {
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    },
    dispose: (): void => {
      clearTimeout(timer);
      decorations.clear();
    },
  };
}
