import type { Point } from '@vizscript/core';
import { useEventListener } from '@vueuse/core';
import { ref } from 'vue';
import { HOTKEYS } from './menu-data';
import type { CanvasContext, MenuState } from './types';

export interface CanvasKeyDeps {
  /** Last pointer position in client coordinates. */
  pointer: Readonly<Point>;
  openMenu: (state: MenuState) => void;
  openSearch: () => Promise<void>;
  duplicateSelection: () => void;
  createCommentBox: (ids: ReadonlyArray<string>, client: Point) => void;
  navigate: (direction: 'back' | 'forward') => void;
  undo: () => void;
  redo: () => void;
  goToDefinition: (id: string) => void;
}

export interface CanvasKeys {
  onKeydown: (event: KeyboardEvent) => void;
  onHotkeyDown: (event: KeyboardEvent) => void;
  onHotkeyUp: (event: KeyboardEvent) => void;
  onPointerDownCapture: (event: PointerEvent) => void;
}

/** Shortcuts of the focused canvas and UE's hold-a-key-and-click nodes. */
export function useCanvasKeys(ctx: CanvasContext & CanvasKeyDeps): CanvasKeys {
  const { props, canvas, selection } = ctx;

  function onKeydown(event: KeyboardEvent): void {
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.target !== canvas.value) {
      return;
    }

    if (
      event.altKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      event.preventDefault();
      ctx.navigate(event.key === 'ArrowLeft' ? 'back' : 'forward');
      return;
    }

    if (command && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        ctx.redo();
      } else {
        ctx.undo();
      }
    } else if (command && key === 'y') {
      event.preventDefault();
      ctx.redo();
    } else if (command && key === 'f') {
      event.preventDefault();
      void ctx.openSearch();
    } else if (command && key === 'd') {
      event.preventDefault();
      ctx.duplicateSelection();
    } else if (event.key === 'F12' && selection.value.length === 1) {
      event.preventDefault();
      ctx.goToDefinition(selection.value[0] ?? '');
    } else if (
      key === 'c' &&
      !command &&
      !event.altKey &&
      !event.shiftKey &&
      selection.value.length > 0
    ) {
      // Like UE: C puts a comment box around the selection.
      event.preventDefault();
      ctx.createCommentBox(selection.value, {
        x: ctx.pointer.x,
        y: ctx.pointer.y,
      });
    } else if (
      event.key === 'ContextMenu' ||
      (event.shiftKey && key === 'f10')
    ) {
      // Keyboard access to the context menu of the selection.
      event.preventDefault();
      const rect = canvas.value?.getBoundingClientRect();
      const first = selection.value[0];
      ctx.openMenu({
        world: { x: 0, y: 0 },
        client: { x: (rect?.left ?? 0) + 40, y: (rect?.top ?? 0) + 40 },
        target: first
          ? { kind: 'node', nodeId: first }
          : { kind: 'background' },
      });
    }
  }

  const heldKey = ref<string | null>(null);

  function onHotkeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (
      event.target === canvas.value &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      key in HOTKEYS
    ) {
      heldKey.value = key;
    }
  }

  function onHotkeyUp(event: KeyboardEvent): void {
    if (event.key.toLowerCase() === heldKey.value) {
      heldKey.value = null;
    }
  }

  useEventListener(window, 'blur', () => {
    heldKey.value = null;
  });

  function onPointerDownCapture(event: PointerEvent): void {
    const hotkey = heldKey.value ? HOTKEYS[heldKey.value] : undefined;
    const v = ctx.view.value;
    if (!hotkey || !v || !props.editable || event.button !== 0) {
      return;
    }

    const world = v.worldAt(event.clientX, event.clientY);
    if (
      !v.isEmptyAt(world) ||
      (hotkey.flow && !(props.types?.flow ?? []).includes(hotkey.flow))
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    ctx.addNode(hotkey.template, {
      world,
      client: { x: event.clientX, y: event.clientY },
      target: { kind: 'background' },
    });
  }

  return { onKeydown, onHotkeyDown, onHotkeyUp, onPointerDownCapture };
}
