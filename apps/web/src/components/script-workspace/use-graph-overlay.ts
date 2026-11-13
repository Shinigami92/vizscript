import type {
  FloatingNodes,
  GraphDocument,
  GraphEdit,
  GraphOverlay,
  ImportedDeclaration,
  NodeTemplate,
  OverlayIssue,
  Point,
} from '@vizscript/core';
import {
  compactOverlay,
  EMPTY_OVERLAY,
  findNode,
  isEmptyOverlay,
} from '@vizscript/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, shallowRef } from 'vue';
import type { GraphClient } from '../../graph/graph-client';
import type { Problem } from '../../graph/problems';

export interface GraphOverlayDeps {
  path: () => string;
  text: Ref<string>;
  client: GraphClient;
  imports: () => ImportedDeclaration[];
  /** The graph as shown (parsed code plus overlay). */
  doc: ShallowRef<GraphDocument | null>;
  /** Writes the synced code (one undo step in the editor). */
  writeCode: (text: string) => void;
  /** The overlay changed: show it, store it with the draft. */
  changed: (overlay: GraphOverlay) => void;
  /** A user's graph-only edit, for undo. */
  record: (before: GraphOverlay, after: GraphOverlay) => void;
  /** The last recorded step also wrote code (one undo for both). */
  recordCode: () => void;
  /** Positions for new floating nodes (where they were dropped). */
  placeFloating: (edit: FloatingNodes, world: Point) => void;
  /** Floating nodes were written as code: their nodes got these ids. */
  placed: (ids: Record<string, string>) => void;
  show: (message: string, kind?: 'info' | 'error') => void;
}

export interface WorkspaceGraphOverlay {
  overlay: ShallowRef<GraphOverlay>;
  issues: ShallowRef<OverlayIssue[]>;
  outOfSync: ComputedRef<boolean>;
  /** Nodes drawn as "not in code" (graph-only, or named by an issue). */
  syncNodes: ComputedRef<Set<string>>;
  /** The issues as problems (Problems panel, node tooltips). */
  syncProblems: ComputedRef<Problem[]>;
  /** Keeps edits in the graph only; writes code once it is valid. */
  addEdits: (edits: ReadonlyArray<GraphEdit>) => void;
  /**
   * Nodes with no place in the code yet: they float where they were dropped
   * until they are wired in.
   */
  addFloating: (
    template: NodeTemplate,
    world: Point,
    fnId: string | undefined
  ) => Promise<void>;
  /** Replaces the overlay (draft loaded, undo, remapped after a parse). */
  setOverlay: (overlay: GraphOverlay) => void;
  discard: () => void;
  /** Writes the overlay as code when the graph is valid. */
  resolve: () => Promise<void>;
}

/**
 * Graph-only edits (UE lets a graph be in states that don't compile yet):
 * kept as an overlay on the parsed graph, shown as "not in code", and
 * written as code automatically once the whole graph is valid again.
 */
export function useGraphOverlay(
  deps: GraphOverlayDeps,
  initial: GraphOverlay | undefined
): WorkspaceGraphOverlay {
  const overlay = shallowRef<GraphOverlay>(initial ?? EMPTY_OVERLAY);
  const issues = shallowRef<OverlayIssue[]>([]);
  const outOfSync = computed(() => !isEmptyOverlay(overlay.value));
  /** The last change was the user's graph edit (its undo step takes code). */
  let userEdit = false;
  let told = false;
  let seq = 0;

  function setOverlay(next: GraphOverlay): void {
    overlay.value = next;
    if (isEmptyOverlay(next)) {
      issues.value = [];
      told = false;
    }

    deps.changed(next);
  }

  function addEdits(edits: ReadonlyArray<GraphEdit>): void {
    const before = overlay.value;
    // Floating nodes deleted again leave nothing behind.
    const after = compactOverlay({ edits: [...before.edits, ...edits] });
    deps.record(before, after);
    userEdit = true;
    if (!told) {
      told = true;
      deps.show(
        'Kept in the graph only: the code follows once the graph is valid again.'
      );
    }

    setOverlay(after);
    void resolve();
  }

  let groups = 0;
  async function addFloating(
    template: NodeTemplate,
    world: Point,
    fnId: string | undefined
  ): Promise<void> {
    const group = `${Date.now().toString(36)}${(groups++).toString(36)}`;
    const result = await deps.client.floatingNodes(
      deps.text.value,
      deps.path(),
      template,
      fnId,
      group,
      deps.imports()
    );
    if (!result.ok) {
      deps.show(result.error, 'error');
      return;
    }

    deps.placeFloating(result.edit, world);
    addEdits([result.edit]);
  }

  function discard(): void {
    if (isEmptyOverlay(overlay.value)) {
      return;
    }

    deps.record(overlay.value, EMPTY_OVERLAY);
    userEdit = false;
    setOverlay(EMPTY_OVERLAY);
  }

  async function resolve(): Promise<void> {
    const current = overlay.value;
    const source = deps.text.value;
    if (isEmptyOverlay(current)) {
      issues.value = [];
      return;
    }

    const mine = ++seq;
    const result = await deps.client.resolveOverlay(
      source,
      deps.path(),
      current,
      deps.imports()
    );
    // Something changed meanwhile: a newer resolve runs.
    if (
      mine !== seq ||
      overlay.value !== current ||
      deps.text.value !== source
    ) {
      return;
    }

    if (result.status === 'pending') {
      issues.value = result.issues;
      return;
    }

    const wrote = result.text !== source;
    if (result.placed) {
      deps.placed(result.placed);
    }

    if (wrote) {
      deps.writeCode(result.text);
    }

    if (userEdit && wrote) {
      deps.recordCode();
    }

    userEdit = false;
    setOverlay(EMPTY_OVERLAY);
  }

  const syncNodes = computed(() => {
    const ids = new Set(issues.value.map((i) => i.node).filter(Boolean));
    for (const fn of deps.doc.value?.functions ?? []) {
      for (const n of fn.nodes) {
        if (n.graphOnly) {
          ids.add(n.id);
        }
      }
    }

    return ids;
  });

  const syncProblems = computed((): Problem[] => {
    const doc = deps.doc.value;
    const text = deps.text.value;
    return issues.value.flatMap((issue) => {
      const node = doc && issue.node ? findNode(doc, issue.node) : undefined;
      const range = node?.range ?? { start: 0, end: 0 };
      const before = text.slice(0, range.start).split('\n');
      return [
        {
          message: `Graph not in sync: ${issue.message}`,
          severity: 'warning',
          range,
          line: before.length,
          column: (before.at(-1)?.length ?? 0) + 1,
          source: 'graph',
        },
      ];
    });
  });

  return {
    overlay,
    issues,
    outOfSync,
    syncNodes,
    syncProblems,
    addEdits,
    addFloating,
    setOverlay,
    discard,
    resolve,
  };
}
