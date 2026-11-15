import type {
  FloatingNodes,
  GraphEdit,
  GraphOverlay,
  ImportedDeclaration,
  Point,
  Positions,
} from '@vizscript/core';
import {
  isLooseKey,
  looseFromLayout,
  looseLayoutKeys,
  splitLoose,
} from '@vizscript/core';
import type { Ref, ShallowRef } from 'vue';
import type { GraphClient } from '../../graph/graph-client';

export interface LooseNodes {
  /** Stores the overlay's loose nodes with the layout (after a change). */
  store: (overlay: GraphOverlay) => void;
  /**
   * The loose nodes stored with the layout, made again from their code
   * (after the layout and the code are loaded).
   */
  restore: () => Promise<void>;
}

/**
 * Loose graph-only nodes (wired to nothing of the code) are part of the
 * file's layout, like comment box colors: they survive saving and
 * reloading, while other graph-only edits live with the draft.
 */
export function useLooseNodes(deps: {
  pinned: ShallowRef<Positions>;
  /** Changes layout entries without an undo step. */
  patchLayout: (patch: Record<string, Point | null>) => void;
  client: GraphClient;
  text: Ref<string>;
  path: () => string;
  imports: () => ImportedDeclaration[];
  typeFloating: (edit: FloatingNodes, text: string) => Promise<FloatingNodes>;
  overlay: () => GraphOverlay;
  /** Shows restored nodes (no undo step, nothing to write). */
  setOverlay: (overlay: GraphOverlay) => void;
}): LooseNodes {
  function store(overlay: GraphOverlay): void {
    const wanted = looseLayoutKeys(splitLoose(overlay).loose);
    const patch: Record<string, Point | null> = {};
    for (const key of Object.keys(deps.pinned.value)) {
      if (isLooseKey(key) && !(key in wanted)) {
        patch[key] = null;
      }
    }

    for (const [key, point] of Object.entries(wanted)) {
      if (!(key in deps.pinned.value)) {
        patch[key] = point;
      }
    }

    if (Object.keys(patch).length > 0) {
      deps.patchLayout(patch);
    }
  }

  async function restore(): Promise<void> {
    const { groups, wires } = looseFromLayout(deps.pinned.value);
    const current = deps.overlay();
    const have = new Set(
      current.edits.flatMap((e) => (e.type === 'addNodes' ? [e.id] : []))
    );
    const made: GraphEdit[] = [];
    for (const group of groups) {
      if (have.has(group.id)) {
        continue;
      }

      const result = await deps.client.floatingNodes(
        deps.text.value,
        deps.path(),
        group.statement
          ? { type: 'code', code: group.code }
          : { type: 'value', expression: group.code },
        group.fnId,
        group.id,
        deps.imports()
      );
      if (result.ok) {
        made.push(await deps.typeFloating(result.edit, result.text));
      }
    }

    if (made.length === 0) {
      return;
    }

    const nodes = new Set(
      made.flatMap((e) =>
        e.type === 'addNodes' ? e.nodes.map((n) => n.id) : []
      )
    );
    deps.setOverlay({
      edits: [
        ...current.edits,
        ...made,
        ...wires.filter((w) => nodes.has(w.to.node)),
      ],
    });
  }

  return { store, restore };
}
