import type { GraphDocument } from '@vizscript/core';
import { useEventListener } from '@vueuse/core';
import type { ComputedRef, ShallowRef } from 'vue';
import { computed, nextTick, shallowRef } from 'vue';
import { monacoLanguage } from '../../graph/languages';
import type { Problem } from '../../graph/problems';
import { problemsByNode } from '../../graph/problems';
import { useWorkbenchStore } from '../../stores/workbench';
import type { CodeEditorInstance, GraphCanvasInstance } from './types';

export interface ProblemDeps {
  path: () => string;
  doc: ShallowRef<GraphDocument | null>;
  editor: Readonly<ShallowRef<CodeEditorInstance | null>>;
  canvas: Readonly<ShallowRef<GraphCanvasInstance | null>>;
  codeVisible: ComputedRef<boolean>;
  graphVisible: ComputedRef<boolean>;
  /** Problems that aren't editor markers (the graph not in sync). */
  extra?: () => Problem[];
}

export interface WorkspaceProblems {
  diagnostics: ComputedRef<GraphDocument['diagnostics']>;
  /** Parser problems shown as editor markers (when there is no checker). */
  parserDiagnostics: ComputedRef<GraphDocument['diagnostics']>;
  /** The editor's markers. */
  problems: ShallowRef<Problem[]>;
  /** Every problem of the file: markers and `extra`. */
  allProblems: ComputedRef<Problem[]>;
  nodeProblems: ComputedRef<ReturnType<typeof problemsByNode>>;
  problemCounts: ComputedRef<{ errors: number; warnings: number }>;
  showProblem: (problem: Problem) => Promise<void>;
}

/** Problems of the file: editor markers, parser diagnostics, per node. */
export function useProblems(deps: ProblemDeps): WorkspaceProblems {
  const { doc, editor, canvas, codeVisible, graphVisible } = deps;
  const workbench = useWorkbenchStore();

  const diagnostics = computed(() => doc.value?.diagnostics ?? []);

  /** TypeScript and JavaScript are checked by the editor itself. */
  const hasChecker = computed(() =>
    ['typescript', 'javascript'].includes(monacoLanguage(deps.path()))
  );
  /** Parser problems shown as editor markers (when there is no checker). */
  const parserDiagnostics = computed(() =>
    hasChecker.value ? [] : diagnostics.value
  );
  /** Every problem of the file, from the editor's markers. */
  const problems = shallowRef<Problem[]>([]);
  const allProblems = computed(() => [
    ...problems.value,
    ...(deps.extra?.() ?? []),
  ]);
  const nodeProblems = computed(() =>
    problemsByNode(doc.value, allProblems.value)
  );
  const problemCounts = computed(() => ({
    errors: allProblems.value.filter((p) => p.severity === 'error').length,
    warnings: allProblems.value.filter((p) => p.severity === 'warning').length,
  }));

  async function showProblem(problem: Problem): Promise<void> {
    if (!codeVisible.value) {
      workbench.show('code');
      await nextTick();
    }

    const node = [...nodeProblems.value].find(([, list]) =>
      list.includes(problem)
    )?.[0];
    if (node && graphVisible.value) {
      canvas.value?.selectNodes([node]);
    }

    // A code view that was just shown needs a frame to get its size.
    await new Promise(requestAnimationFrame);
    editor.value?.layout();
    editor.value?.reveal(problem.range, true);
  }

  // Like VS Code: Shift+Cmd+M (Shift+Ctrl+M) toggles the problems panel.
  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === 'm'
    ) {
      event.preventDefault();
      workbench.toggle('problems');
    }
  });

  return {
    diagnostics,
    parserDiagnostics,
    problems,
    allProblems,
    nodeProblems,
    problemCounts,
    showProblem,
  };
}
