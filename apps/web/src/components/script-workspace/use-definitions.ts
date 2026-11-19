import type { GraphDocument, ModuleReference } from '@vizscript/core';
import { findDefinition, findNode } from '@vizscript/core';
import type { ComputedRef, ShallowRef } from 'vue';
import { nextTick, watch } from 'vue';
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router';
import type { ResolveReference } from './symbol-lookup';
import { describeTarget, findDefinitionTarget } from './symbol-lookup';
import type { CodeEditorInstance, GraphCanvasInstance } from './types';

interface DefinitionDeps {
  doc: ShallowRef<GraphDocument | null>;
  /** The text `doc` was parsed from. */
  docText: () => string;
  references: ShallowRef<ModuleReference[]>;
  resolveReference: ResolveReference;
  editor: Readonly<ShallowRef<CodeEditorInstance | null>>;
  canvas: Readonly<ShallowRef<GraphCanvasInstance | null>>;
  visualizable: ComputedRef<boolean>;
  codeVisible: ComputedRef<boolean>;
  graphVisible: ComputedRef<boolean>;
  route: RouteLocationNormalizedLoaded;
  router: Router;
  focusFunction: (fnId: string | null) => Promise<void>;
  selectNodes: (ids: string[]) => Promise<void>;
  /** Shows a node's code (a single click's activation). */
  onActivate: (id: string) => Promise<void>;
  /** Opens another file of the repository at a symbol. */
  open: (path: string, symbol?: string) => void;
  show: (message: string) => void;
}

export interface Definitions {
  /** Where Go to definition of a node leads, if anywhere. */
  describeDefinition: (nodeId: string) => string | undefined;
  goToDefinition: (nodeId: string) => Promise<void>;
  /** Where the graph of an entry node is used (the way back). */
  usagesOf: (entryId: string) => Array<{ nodeId: string; label: string }>;
  jumpTo: (nodeId: string) => Promise<void>;
  onNodeActivate: (nodeId: string) => Promise<void>;
  /** Shows the `?symbol=` of a link once the file is parsed. */
  revealPendingSymbol: () => Promise<void>;
}

/**
 * Go to definition and back, like UE's: a call or callback node leads to
 * its graph (or the file that declares it), an entry node to its uses,
 * and a link's `?symbol=` to its declaration once the file is shown.
 */
export function useDefinitions(deps: DefinitionDeps): Definitions {
  const { doc, references, resolveReference } = deps;

  function targetOf(nodeId: string): ReturnType<typeof findDefinitionTarget> {
    return findDefinitionTarget(
      doc.value,
      deps.docText(),
      references.value,
      resolveReference,
      nodeId
    );
  }

  function describeDefinition(nodeId: string): string | undefined {
    return describeTarget(targetOf(nodeId));
  }

  async function goToDefinition(nodeId: string): Promise<void> {
    const target = targetOf(nodeId);
    if (!target) {
      deps.show('No definition found for this node.');
      return;
    }

    if (target.kind === 'file') {
      deps.open(target.path, target.symbol);
      return;
    }

    // UE opens the graph of a function or collapsed graph.
    await deps.focusFunction(target.fnId);
    await deps.selectNodes([target.nodeId]);
    await deps.onActivate(target.nodeId);
  }

  /**
   * Where the graph of an entry node is used: the nodes whose Go to
   * definition leads to it (a callback's node, the calls of a function).
   */
  function usagesOf(entryId: string): Array<{ nodeId: string; label: string }> {
    const d = doc.value;
    const fn = d?.functions.find((f) => f.nodes.some((n) => n.id === entryId));
    if (!d || !fn) {
      return [];
    }

    const text = deps.docText();
    return d.functions.flatMap((other) =>
      other.nodes
        .filter((node) => {
          if (node.kind !== 'call' && node.kind !== 'functionRef') {
            return false;
          }

          const target = targetOf(node.id);
          return target?.kind === 'node' && target.fnId === fn.id;
        })
        .map((node) => ({
          nodeId: node.id,
          label: `${other.name} · line ${text.slice(0, node.range.start).split('\n').length}`,
        }))
    );
  }

  /** Shows a node of any function, switching the focused graph if needed. */
  async function jumpTo(nodeId: string): Promise<void> {
    await deps.selectNodes([nodeId]);
  }

  /**
   * Double-click on a node: a call or callback opens the graph it leads to
   * (UE's double-click on a function or collapsed graph node); other nodes
   * show their code.
   */
  async function onNodeActivate(nodeId: string): Promise<void> {
    const node = doc.value ? findNode(doc.value, nodeId) : undefined;
    if (
      (node?.kind === 'call' || node?.kind === 'functionRef') &&
      describeDefinition(nodeId) !== undefined
    ) {
      await goToDefinition(nodeId);
      return;
    }

    await deps.onActivate(nodeId);
  }

  /** Definition to show once the file is parsed (`?symbol=` from a link). */
  let pendingSymbol =
    typeof deps.route.query.symbol === 'string'
      ? deps.route.query.symbol
      : null;

  async function revealPendingSymbol(): Promise<void> {
    const symbol = pendingSymbol;
    if (!symbol || (deps.visualizable.value && !doc.value)) {
      return;
    }

    if (deps.codeVisible.value && !deps.editor.value) {
      // The editor loads lazily; it calls again when it is ready.
      return;
    }

    pendingSymbol = null;
    const { symbol: _, ...query } = deps.route.query;
    void deps.router.replace({ query });
    const text = deps.docText();
    const range = findDefinition(doc.value, text, symbol);
    if (!range) {
      deps.show(`${symbol} was not found in this file.`);
      return;
    }

    const fn = doc.value?.functions.find(
      (f) => f.range.start === range.start && f.range.end === range.end
    );
    const entry = fn?.nodes.find((n) => n.kind === 'entry');
    if (entry && deps.graphVisible.value) {
      await nextTick();
      deps.canvas.value?.selectNodes([entry.id]);
    }

    // Once a freshly mounted editor has its size, show the definition near
    // the top (this also ends the scroll started by the node selection).
    await new Promise(requestAnimationFrame);
    const line = text.slice(0, range.start).split('\n').length;
    deps.editor.value?.revealLine(line, true);
  }

  watch(deps.editor, () => void revealPendingSymbol());

  return {
    describeDefinition,
    goToDefinition,
    usagesOf,
    jumpTo,
    onNodeActivate,
    revealPendingSymbol,
  };
}
