import type { NodeTemplate, PinRef, Point } from '@vizscript/core';
import { useEventListener } from '@vueuse/core';
import { continuation, selectionCode } from './graph-helpers';
import { NODES_MIME } from './menu-data';
import type { CanvasContext } from './types';

export interface GraphClipboard {
  /** Copies the code of nodes (like Ctrl+C); false when there is none. */
  copyCode: (ids: ReadonlyArray<string>) => Promise<boolean>;
  cutNodes: (ids: ReadonlyArray<string>) => Promise<void>;
  /** "Paste": after the node when it is a statement, else at the point. */
  pasteFromClipboard: (world: Point, nodeId?: string) => Promise<void>;
  /** UE's Ctrl+D: a copy of the selection right after it. */
  duplicateSelection: () => void;
}

/**
 * Copy, cut, paste and duplicate of nodes as code, from the menus and from
 * the document's clipboard events while the canvas has the focus.
 */
export function useGraphClipboard(
  ctx: CanvasContext & { pointer: Readonly<Point> }
): GraphClipboard {
  const { props, emitOp, show } = ctx;

  async function copyCode(ids: ReadonlyArray<string>): Promise<boolean> {
    const { code } = selectionCode(ctx.index.value, props.text, ids);
    if (!code) {
      show('These nodes have no source code to copy.');
      return false;
    }

    try {
      await navigator.clipboard.writeText(code);
      return true;
    } catch {
      show('The clipboard is not available.', 'error');
      return false;
    }
  }

  async function cutNodes(ids: ReadonlyArray<string>): Promise<void> {
    if (await copyCode(ids)) {
      emitOp({ type: 'deleteNodes', nodeIds: [...ids] });
    }
  }

  async function pasteFromClipboard(
    world: Point,
    nodeId?: string
  ): Promise<void> {
    let code = '';
    try {
      code = await navigator.clipboard.readText();
    } catch {
      show('The clipboard is not available.', 'error');
      return;
    }

    if (!code.trim()) {
      show('The clipboard is empty.');
      return;
    }

    const node = nodeId ? ctx.index.value.nodes.get(nodeId)?.node : undefined;
    pasteCode(
      code,
      world,
      node?.purity === 'impure' ? continuation(node) : undefined
    );
  }

  function canvasHasFocus(): boolean {
    return document.activeElement === ctx.canvas.value;
  }

  function onCopy(event: ClipboardEvent, cut = false): void {
    const selection = ctx.selection.value;
    if (!canvasHasFocus() || selection.length === 0) {
      return;
    }

    const { code } = selectionCode(ctx.index.value, props.text, selection);
    if (!code) {
      return;
    }

    event.preventDefault();
    event.clipboardData?.setData('text/plain', code);
    event.clipboardData?.setData(
      NODES_MIME,
      JSON.stringify({ language: props.doc?.language ?? '' })
    );
    if (cut && props.editable) {
      emitOp({ type: 'deleteNodes', nodeIds: [...selection] });
    }
  }

  /** Where the pointer is in the graph, else the middle of the view. */
  function pointerWorld(): Point | undefined {
    const v = ctx.view.value;
    const rect = ctx.canvas.value?.getBoundingClientRect();
    if (!v || !rect) {
      return undefined;
    }

    const { pointer } = ctx;
    const inside =
      pointer.x >= rect.left &&
      pointer.x <= rect.right &&
      pointer.y >= rect.top &&
      pointer.y <= rect.bottom;
    return inside
      ? v.worldAt(pointer.x, pointer.y)
      : v.worldAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /**
   * Inserts code as nodes: after the selected statement, else at the end of
   * the function under the pointer, where the pointer is.
   */
  function pasteCode(code: string, world: Point, after?: PinRef): void {
    const template: NodeTemplate = { type: 'code', code };
    if (after) {
      emitOp({ type: 'addNode', template, after, position: world });
      return;
    }

    // Without a place in the code, the nodes float until they are wired in.
    const place = ctx.placeAt(world);
    emitOp({ type: 'addNode', template, ...place?.anchor, position: world });
  }

  function onPaste(event: ClipboardEvent): void {
    if (!canvasHasFocus() || !props.editable) {
      return;
    }

    const code = event.clipboardData?.getData('text/plain') ?? '';
    const world = pointerWorld();
    if (!code.trim() || !world) {
      return;
    }

    event.preventDefault();
    try {
      const from = JSON.parse(
        event.clipboardData?.getData(NODES_MIME) || '{}'
      ) as { language?: string };
      if (from.language && from.language !== props.doc?.language) {
        show(
          `Pasted ${from.language} code into a ${props.doc?.language} file.`
        );
      }
    } catch {
      // not copied from a graph
    }

    // After the selected statement when the pointer is in its function,
    // else at the end of the function under the pointer.
    const selection = ctx.selection.value;
    const only = selection.length === 1 ? selection[0] : undefined;
    const entry = only ? ctx.index.value.nodes.get(only) : undefined;
    const sameFunction = entry?.fn.id === ctx.view.value?.functionAt(world);
    pasteCode(
      code,
      world,
      entry?.node.purity === 'impure' && sameFunction
        ? continuation(entry.node)
        : undefined
    );
  }

  function duplicateSelection(): void {
    const selection = ctx.selection.value;
    if (!props.editable || selection.length === 0) {
      return;
    }

    const { code, statements } = selectionCode(
      ctx.index.value,
      props.text,
      selection
    );
    const last = statements.at(-1);
    const positions = ctx.view.value?.getPositions() ?? {};
    const origin = positions[selection[0] ?? ''];
    if (!code) {
      return;
    }

    const world = origin
      ? { x: origin.x + 40, y: origin.y + 40 }
      : pointerWorld();
    if (world) {
      pasteCode(code, world, last ? continuation(last) : undefined);
    }
  }

  useEventListener(document, 'copy', (event) => onCopy(event));
  useEventListener(document, 'cut', (event) => onCopy(event, true));
  useEventListener(document, 'paste', onPaste);

  return { copyCode, cutNodes, pasteFromClipboard, duplicateSelection };
}
