import type { NodeTemplate } from '@vizscript/core';
import { qualifiedName } from '@vizscript/core';
import type { Ref } from 'vue';
import { ref } from 'vue';
import { isMac } from '../../graph/source';
import { SYMBOL_DRAG_MIME } from '../../graph/symbols';
import type { MenuEntry } from '../ContextMenu.vue';
import { memberAccess, typeDefault } from './graph-helpers';
import type { CanvasContext } from './types';

export interface SymbolDrop {
  /** Get / Set menu of a variable dropped into the graph (like UE). */
  dropMenu: Ref<{ x: number; y: number; entries: MenuEntry[] } | null>;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

/** Symbols dragged from "My Script" become nodes where they are dropped. */
export function useSymbolDrop(ctx: CanvasContext): SymbolDrop {
  const { props, emitOp, show } = ctx;
  const dropMenu = ref<{ x: number; y: number; entries: MenuEntry[] } | null>(
    null
  );

  function onDragOver(event: DragEvent): void {
    if (
      props.editable &&
      event.dataTransfer?.types.includes(SYMBOL_DRAG_MIME)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function onDrop(event: DragEvent): void {
    const id = event.dataTransfer?.getData(SYMBOL_DRAG_MIME);
    const v = ctx.view.value;
    const doc = props.doc;
    if (!id || !v || !doc || !props.editable) {
      return;
    }

    event.preventDefault();
    const symbol = doc.symbols?.find((s) => s.id === id);
    if (!symbol) {
      return;
    }

    const world = v.worldAt(event.clientX, event.clientY);
    const place = ctx.placeAt(world);
    if (!place) {
      show('Drop it into a function.');
      return;
    }

    const { fnId, anchor } = place;

    const owner = doc.symbols?.find(
      (s) => s.fnId === fnId && (s.kind === 'function' || s.kind === 'method')
    );
    const add = (template: NodeTemplate): void =>
      emitOp({ type: 'addNode', template, ...anchor, position: world });

    if (
      symbol.kind === 'function' ||
      symbol.kind === 'method' ||
      symbol.kind === 'signal'
    ) {
      const callee =
        symbol.kind === 'signal'
          ? `${symbol.name}.emit`
          : memberAccess(symbol, owner, doc.language);
      if (!callee) {
        show(`Methods of ${symbol.scope} can be dropped into its own methods.`);
        return;
      }

      // Like a new call node: its inputs show as pins (from the signature)
      // that fill in the arguments when they get a value or a wire.
      add({ type: 'call', callee });
      return;
    }

    if (symbol.kind === 'import') {
      // Without the module's declarations it may be a function or a value.
      const name = symbol.name;
      const call =
        symbol.imported === '*'
          ? symbol.modifiers.some((m) => m === 'preload' || m === 'load')
            ? `${name}.new`
            : undefined
          : name;
      const get = (): void => add({ type: 'value', expression: name });
      const kind = symbol.importedKind;
      if (kind === 'function' && !event.ctrlKey && !event.metaKey) {
        // Known from its file: a call node with the function's inputs.
        add({ type: 'call', callee: name });
        return;
      }

      if (
        event.ctrlKey ||
        event.metaKey ||
        !call ||
        kind === 'variable' ||
        kind === 'constant'
      ) {
        get();
        return;
      }

      dropMenu.value = {
        x: event.clientX,
        y: event.clientY,
        entries: [
          { type: 'header', label: name },
          {
            label: `Call ${call}()`,
            icon: 'i-mdi-function',
            action: () => add({ type: 'call', callee: call }),
          },
          {
            label: `Get ${name}`,
            icon: 'i-mdi-arrow-right-bold-box-outline',
            shortcut: isMac ? '⌘ drag' : 'Ctrl drag',
            action: get,
          },
        ],
      };
      return;
    }

    if (
      symbol.kind === 'local' &&
      owner &&
      qualifiedName(owner) !== symbol.scope
    ) {
      show(`${symbol.name} is a local variable of ${symbol.scope}.`);
      return;
    }

    const name = memberAccess(symbol, owner, doc.language);
    if (!name) {
      show(`Members of ${symbol.scope} can be dropped into its own methods.`);
      return;
    }

    const get = (): void => add({ type: 'value', expression: name });
    const set = (): void =>
      add({
        type: 'setVar',
        name,
        declaration: 'none',
        value: typeDefault(props.types, symbol.type?.text),
      });
    // UE: Ctrl-drag gets, Alt-drag sets, otherwise ask.
    if (event.ctrlKey || event.metaKey) {
      get();
    } else if (event.altKey && symbol.kind !== 'constant') {
      set();
    } else {
      dropMenu.value = {
        x: event.clientX,
        y: event.clientY,
        entries: [
          { type: 'header', label: name },
          {
            label: `Get ${name}`,
            icon: 'i-mdi-arrow-right-bold-box-outline',
            shortcut: isMac ? '⌘ drag' : 'Ctrl drag',
            action: get,
          },
          {
            label: `Set ${name}`,
            icon: 'i-mdi-arrow-left-bold-box-outline',
            shortcut: isMac ? '⌥ drag' : 'Alt drag',
            disabled: symbol.kind === 'constant',
            action: set,
          },
        ],
      };
    }
  }

  return { dropMenu, onDragOver, onDrop };
}
