import type {
  GraphDocument,
  GraphOp,
  OpResult,
  TextEdit,
} from '@vizscript/core';
import { floatsUntilWired, graphEditsFor } from '@vizscript/core';
import type { Toast } from '../../composables/use-toasts';
import { topLevelGraph } from '../../graph/symbols';
import type { PendingPlacement } from './placement';
import { placementFor } from './placement';
import type { WorkspaceGraphOverlay } from './use-graph-overlay';
import type { KeptNodes } from './use-kept-nodes';
import type { ViaWires } from './use-via-wires';

export interface OpRunnerDeps {
  editable: () => boolean;
  /** The text in the editor. */
  text: () => string;
  /** The text the graph (`doc`) was parsed from. */
  parsedText: () => string;
  reparse: () => Promise<void>;
  /** The graph as shown (with graph-only edits). */
  doc: () => GraphDocument | null;
  /** The graph of the code alone. */
  parsedDoc: () => GraphDocument | null;
  /** The function shown on its own (focus mode). */
  focusFn: () => string | null;
  /** The graph has edits the code doesn't have yet. */
  outOfSync: () => boolean;
  /** The language's value of an empty input. */
  placeholder: () => string;
  vias: Pick<ViaWires, 'throughVias' | 'beforeOp' | 'cancelOp'>;
  keptNodes: Pick<KeptNodes, 'beforeOp' | 'cancelOp' | 'deleteLoose'>;
  overlay: Pick<
    WorkspaceGraphOverlay,
    | 'addEdits'
    | 'addFloating'
    | 'fillCutReceiver'
    | 'floatInput'
    | 'floatReceiver'
    | 'floatValueUse'
  >;
  /** Pins the current auto layout, so the edit moves no other node. */
  freezeLayout: () => void;
  /** Notes the editor's version before code edits (undo of the layout). */
  beforeCodeEdit: () => void;
  /** The op's edits on `text` (in the worker). */
  applyOp: (text: string, op: GraphOp) => Promise<OpResult>;
  /** Writes the edits made on `base` into the editor. */
  write: (
    base: string,
    edits: ReadonlyArray<TextEdit>,
    placement: PendingPlacement | null
  ) => void;
  /** Like UE, nothing stays selected after a delete. */
  deselect: () => void;
  show: (message: string, kind?: Toast['kind']) => void;
}

/**
 * Runs graph ops one after the other, so each sees the code the one before
 * left (a description saved on blur by the click on `export`). An op is
 * written into the code when it can be; else it stays in the graph (UE's
 * graphs may be in states that don't compile).
 */
export function useOpRunner(deps: OpRunnerDeps): {
  onOp: (op: GraphOp) => Promise<void>;
} {
  let queue: Promise<void> = Promise.resolve();

  function onOp(op: GraphOp): Promise<void> {
    const next = queue.then(() => runOp(op));
    queue = next.catch(() => undefined);
    return next;
  }

  /** The function a floating node is shown with. */
  function floatingFn(fnId?: string): string | undefined {
    return (
      fnId ?? deps.focusFn() ?? topLevelGraph(deps.parsedDoc(), deps.text())?.id
    );
  }

  /** Ops handled in the graph alone; `true` when `op` was one. */
  async function inGraph(op: GraphOp): Promise<boolean> {
    const { overlay } = deps;
    // A node added on empty space floats until its exec input is wired,
    // like UE's; an imported name gets its import right away.
    const added = op.type === 'withImport' ? op.op : op;
    if (
      added.type === 'addNode' &&
      !added.after &&
      !added.before &&
      floatsUntilWired(added.template)
    ) {
      if (op.type === 'withImport') {
        await runOp({ type: 'addImport', import: op.import });
      }

      deps.freezeLayout();
      await overlay.addFloating(
        added.template,
        added.position ?? { x: 0, y: 0 },
        floatingFn(added.fnId)
      );
      return true;
    }

    // A value for a method's empty `this` (its wire broken in the graph):
    // its nodes are added in the graph and wired in; the code follows when
    // the overlay is written.
    if (
      op.type === 'setInput' &&
      ((await overlay.fillCutReceiver(op, deps.freezeLayout)) ||
        (await overlay.floatInput(op)))
    ) {
      return true;
    }

    // Deleting loose nodes keeps the rest of their groups.
    if (
      op.type === 'deleteNodes' &&
      (await deps.keptNodes.deleteLoose(op.nodeIds))
    ) {
      return true;
    }

    // A receiver wired into a floating call: the call is made with it, so
    // it shows the typed pins of what it calls.
    if (
      op.type === 'connect' &&
      (await overlay.floatReceiver(op, deps.placeholder()))
    ) {
      deps.freezeLayout();
      return true;
    }

    // A node made from a dragged value floats unwired, like UE's.
    if (op.type === 'useValue' || op.type === 'callWith') {
      deps.freezeLayout();
      if (await overlay.floatValueUse(op, deps.placeholder())) {
        return true;
      }
    }

    return false;
  }

  async function runOp(requested: GraphOp): Promise<void> {
    if (!deps.editable()) {
      return;
    }

    // The op was made on the graph of the parsed text: typing not parsed
    // yet is parsed first, so its edits fit the text they are written into.
    if (deps.text() !== deps.parsedText()) {
      await deps.reparse();
    }

    // A wire drawn from a SET stands for a Get node in the code.
    const op = deps.vias.throughVias(requested);
    if (await inGraph(op)) {
      return;
    }

    // Wires and deletions the code can't follow stay in the graph. While
    // the graph has such edits, the next ones join them, so the code
    // follows what is shown.
    const doc = deps.doc();
    const graphEdits = doc ? graphEditsFor(doc, op) : undefined;
    // Loose graph-only nodes are edited in the graph too.
    const loose = JSON.stringify(op).includes('"overlay:');
    if ((deps.outOfSync() || loose) && graphEdits) {
      deps.freezeLayout();
      deps.overlay.addEdits(graphEdits);
      return;
    }

    deps.vias.beforeOp(op, doc);
    deps.keptNodes.beforeOp(op);
    deps.beforeCodeEdit();
    const base = deps.text();
    const result = await deps.applyOp(base, op);
    const fits = deps.text() === base;
    if (!result.ok || result.edits.length === 0 || !fits) {
      deps.vias.cancelOp();
      deps.keptNodes.cancelOp();
    }

    if (!result.ok) {
      if (graphEdits) {
        deps.freezeLayout();
        deps.overlay.addEdits(graphEdits);
      } else if (op.type === 'addNode' && !op.after && !op.before) {
        // No place in the code (e.g. a GDScript class body): it floats in
        // the graph until it is wired in, like a new node in UE.
        deps.freezeLayout();
        await deps.overlay.addFloating(
          op.template,
          op.position ?? { x: 0, y: 0 },
          // Shown with the function in focus, else with the class body.
          floatingFn()
        );
      } else if (loose) {
        deps.show(
          'This node is not in the code yet: wire it in first.',
          'error'
        );
      } else {
        deps.show(result.error, 'error');
      }

      return;
    }

    if (result.edits.length === 0) {
      return;
    }

    if (!fits) {
      // Typed or undone while the edits were made: they no longer fit.
      deps.show('The code changed meanwhile: do the edit again.', 'error');
      return;
    }

    deps.freezeLayout();
    // New nodes go where the wire was dropped or the menu was opened.
    deps.write(base, result.edits, placementFor(op, doc));
    if (op.type === 'deleteNodes') {
      deps.deselect();
    }
  }

  return { onOp };
}
