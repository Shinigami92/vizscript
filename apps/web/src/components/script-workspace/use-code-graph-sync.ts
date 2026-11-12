import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  ScriptSymbol,
  SourceRange,
} from '@vizscript/core';
import { findNode, findNodeAtOffset, qualifiedName } from '@vizscript/core';
import { useEventListener } from '@vueuse/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, nextTick, ref, watch } from 'vue';
import { symbolNodes } from '../../graph/symbols';
import { useWorkbenchStore } from '../../stores/workbench';
import type { CodeEditorInstance, GraphCanvasInstance } from './types';
import type { FocusMode } from './use-focus-mode';

export interface CodeGraphDeps {
  doc: ShallowRef<GraphDocument | null>;
  /** Selected nodes. */
  selection: Ref<string[]>;
  editor: Readonly<ShallowRef<CodeEditorInstance | null>>;
  canvas: Readonly<ShallowRef<GraphCanvasInstance | null>>;
  codeVisible: ComputedRef<boolean>;
  graphVisible: ComputedRef<boolean>;
  focus: Pick<FocusMode, 'focusFn' | 'focusFunction' | 'hiddenFunctionOf'>;
  onOp: (op: GraphOp) => Promise<void>;
}

export interface CodeGraphSync {
  /** Symbol selected in "My Script"; Details shows it instead of nodes. */
  selectedSymbolId: Ref<string | null>;
  selectedSymbol: ComputedRef<ScriptSymbol | null>;
  onSelectionChange: (ids: string[]) => void;
  selectSymbol: (id: string) => void;
  /** Double-click in "My Script": show the symbol in the graph. */
  openSymbol: (id: string) => void;
  revealSymbol: (id: string) => void;
  /** Edits from "My Script"; a renamed selection keeps being selected. */
  onScriptOp: (op: GraphOp) => void;
  revealRange: (range: SourceRange) => Promise<void>;
  /** Selects nodes from outside the canvas (details panel, My Script). */
  selectNodes: (ids: string[]) => Promise<void>;
  selectFunction: (fnId: string) => void;
  onHoverChange: (id: string | null) => void;
  onCursor: (offset: number) => void;
  revealSourceLine: (line: number) => Promise<void>;
  onActivate: (id: string) => Promise<void>;
}

/**
 * Code <-> graph: selections and hovers shown in the editor, cursor moves
 * shown in the graph, and the symbols of "My Script" in both.
 */
export function useCodeGraphSync(deps: CodeGraphDeps): CodeGraphSync {
  const { doc, selection, editor, canvas, codeVisible, graphVisible } = deps;
  const { focusFn, focusFunction, hiddenFunctionOf } = deps.focus;
  const workbench = useWorkbenchStore();

  function rangesOf(ids: ReadonlyArray<string>): SourceRange[] {
    if (!doc.value) {
      return [];
    }

    return ids
      .map((id) => findNode(doc.value as GraphDocument, id))
      .filter((n): n is GraphNode => n !== undefined)
      .map((n) => n.range)
      .filter((r) => r.end > r.start);
  }

  function onSelectionChange(ids: string[]): void {
    selection.value = ids;
    if (ids.length > 0) {
      selectedSymbolId.value = null;
    }

    const ranges = rangesOf(ids);
    editor.value?.setSelectedRanges(ranges);
    const first = ranges[0];
    if (first && codeVisible.value) {
      // Only its start: centering a whole function would hide where it begins.
      editor.value?.reveal({ start: first.start, end: first.start });
    }
  }

  /** Symbol selected in "My Script"; Details shows it instead of nodes. */
  const selectedSymbolId = ref<string | null>(null);
  const selectedSymbol = computed(
    () =>
      doc.value?.symbols?.find((s) => s.id === selectedSymbolId.value) ?? null
  );
  // A symbol's kind can change (`let` → `const`): keep it selected by name.
  watch(doc, (next) => {
    const id = selectedSymbolId.value;
    if (!id || !next?.symbols || next.symbols.some((s) => s.id === id)) {
      return;
    }

    const qualified = id.slice(id.indexOf(':') + 1);
    const same = next.symbols.find((s) => qualifiedName(s) === qualified);
    if (same) {
      selectedSymbolId.value = same.id;
    }
  });

  function selectSymbol(id: string): void {
    canvas.value?.setSelection([]);
    selection.value = [];
    selectedSymbolId.value = id;
    const symbol = selectedSymbol.value;
    if (symbol) {
      editor.value?.setSelectedRanges([symbol.range]);
      if (codeVisible.value) {
        editor.value?.reveal({
          start: symbol.range.start,
          end: symbol.range.start,
        });
      }
    }
  }

  /** Double-click in "My Script": show the symbol in the graph. */
  function openSymbol(id: string): void {
    const symbol = doc.value?.symbols?.find((s) => s.id === id);
    if (!symbol) {
      return;
    }

    // Like UE: double-clicking a function opens its graph.
    if (symbol.fnId) {
      void focusFunction(symbol.fnId);
      return;
    }

    const uses = symbolNodes(doc.value, symbol);
    if (uses.length > 0) {
      void selectNodes(uses);
    }
  }

  function revealSymbol(id: string): void {
    const symbol = doc.value?.symbols?.find((s) => s.id === id);
    if (symbol) {
      void revealRange(symbol.nameRange);
    }
  }

  /** Edits from "My Script"; a renamed selection keeps being selected. */
  function onScriptOp(op: GraphOp): void {
    if (op.type === 'renameSymbol' && selectedSymbolId.value === op.symbol) {
      selectedSymbolId.value = op.symbol.replace(/[^:.]+$/, op.name);
    }

    void deps.onOp(op);
  }

  async function revealRange(range: SourceRange): Promise<void> {
    if (!codeVisible.value) {
      workbench.show('code');
      await nextTick();
    }

    editor.value?.reveal(range, true);
  }

  /** Selects nodes from outside the canvas (details panel, My Script). */
  async function selectNodes(ids: string[]): Promise<void> {
    const fn = hiddenFunctionOf(ids);
    if (fn !== undefined) {
      await focusFunction(fn);
    }

    canvas.value?.selectNodes(ids);
  }

  function selectFunction(fnId: string): void {
    // In focus mode another function opens instead.
    if (focusFn.value && focusFn.value !== fnId) {
      void focusFunction(fnId);
      return;
    }

    canvas.value?.selectFunction(fnId);
  }

  function onHoverChange(id: string | null): void {
    editor.value?.setHoveredRanges(id ? rangesOf([id]) : []);
  }

  function onCursor(offset: number): void {
    if (!doc.value || !graphVisible.value) {
      return;
    }

    const node = findNodeAtOffset(doc.value, offset);
    canvas.value?.setHighlight(node ? [node.id] : []);
    if (node) {
      canvas.value?.revealNodes([node.id]);
    }
  }

  async function revealSourceLine(line: number): Promise<void> {
    if (!codeVisible.value) {
      workbench.show('code');
      await nextTick();
    }

    editor.value?.revealLine(line);
  }

  async function onActivate(id: string): Promise<void> {
    const node = doc.value ? findNode(doc.value, id) : undefined;
    if (!node) {
      return;
    }

    if (!codeVisible.value) {
      workbench.show('code');
      await nextTick();
    }

    editor.value?.reveal(node.range, true);
  }

  useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    const command = event.ctrlKey || event.metaKey;
    if (!command || event.key.toLowerCase() !== 'f' || !graphVisible.value) {
      return;
    }

    const active = document.activeElement;
    const typing =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (!typing) {
      event.preventDefault();
      void canvas.value?.openSearch();
    }
  });

  return {
    selectedSymbolId,
    selectedSymbol,
    onSelectionChange,
    selectSymbol,
    openSymbol,
    revealSymbol,
    onScriptOp,
    revealRange,
    selectNodes,
    selectFunction,
    onHoverChange,
    onCursor,
    revealSourceLine,
    onActivate,
  };
}
