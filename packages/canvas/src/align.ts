import type { GraphEdge, Point } from '@vizscript/core';
import type { AlignMode } from './graph-view-types';

/** A node as the alignment tools see it. */
export interface AlignNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The wire Straighten levels: the y of this node's pin in it, and the
   * node at the other end with its y and its pin's y (both relative).
   */
  level?: { pinY: number; other: string; otherY: number; otherPinY: number };
}

/**
 * The wire Straighten levels for node `id`: its exec input first, else its
 * first wired data input, else its first wired output.
 */
export function levelEdge(
  edges: ReadonlyArray<GraphEdge>,
  id: string
): GraphEdge | undefined {
  const incoming = edges.filter((e) => e.to.node === id);
  return (
    incoming.find((e) => e.kind === 'exec') ??
    incoming[0] ??
    edges.find((e) => e.from.node === id)
  );
}

/**
 * Where UE's alignment tools put the `nodes` (rounded): aligned to the top,
 * middle or bottom, left, center or right, distributed with equal gaps (the
 * outer ones stay), or straightened so the wire into each is level (left
 * to right, following nodes it moved). Fewer than two nodes only
 * straighten.
 */
export function alignNodes(
  mode: AlignMode,
  nodes: ReadonlyArray<AlignNode>
): Map<string, Point> {
  const moved = new Map<string, Point>();
  if (nodes.length === 0 || (mode !== 'straighten' && nodes.length < 2)) {
    return moved;
  }

  const set = (node: AlignNode, x: number, y: number): void => {
    moved.set(node.id, { x: Math.round(x), y: Math.round(y) });
  };
  const top = Math.min(...nodes.map((n) => n.y));
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  const left = Math.min(...nodes.map((n) => n.x));
  const right = Math.max(...nodes.map((n) => n.x + n.width));
  switch (mode) {
    case 'top':
    case 'middle':
    case 'bottom': {
      const middle =
        nodes.reduce((sum, n) => sum + n.y + n.height / 2, 0) / nodes.length;
      for (const n of nodes) {
        const y =
          mode === 'top'
            ? top
            : mode === 'bottom'
              ? bottom - n.height
              : middle - n.height / 2;
        set(n, n.x, y);
      }

      break;
    }

    case 'left':
    case 'center':
    case 'right': {
      const center =
        nodes.reduce((sum, n) => sum + n.x + n.width / 2, 0) / nodes.length;
      for (const n of nodes) {
        const x =
          mode === 'left'
            ? left
            : mode === 'right'
              ? right - n.width
              : center - n.width / 2;
        set(n, x, n.y);
      }

      break;
    }

    case 'distributeHorizontally':
    case 'distributeVertically': {
      const horizontal = mode === 'distributeHorizontally';
      const sorted = nodes.toSorted((a, b) =>
        horizontal ? a.x - b.x : a.y - b.y
      );
      const size = sorted.reduce(
        (sum, n) => sum + (horizontal ? n.width : n.height),
        0
      );
      const span = horizontal ? right - left : bottom - top;
      const gap = (span - size) / Math.max(1, sorted.length - 1);
      let at = horizontal ? left : top;
      for (const n of sorted) {
        set(n, horizontal ? at : n.x, horizontal ? n.y : at);
        at += (horizontal ? n.width : n.height) + gap;
      }

      break;
    }

    case 'straighten': {
      for (const n of nodes.toSorted((a, b) => a.x - b.x)) {
        if (n.level) {
          const otherY = moved.get(n.level.other)?.y ?? n.level.otherY;
          const offset = otherY + n.level.otherPinY - (n.y + n.level.pinY);
          set(n, n.x, n.y + offset);
        }
      }

      break;
    }
  }

  return moved;
}

/** UE's alignment shortcuts. */
export function alignKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'altKey'>
): AlignMode | undefined {
  const key = e.key.toLowerCase();
  if (key === 'q' && !e.shiftKey && !e.altKey) {
    return 'straighten';
  }

  if (!e.shiftKey) {
    return undefined;
  }

  // Alt changes `e.key` on macOS (Alt+Shift+W is „): use the key's code.
  const code = e.code.replace(/^Key/, '').toLowerCase();
  if (e.altKey) {
    return code === 'w' ? 'middle' : code === 's' ? 'center' : undefined;
  }

  const modes: Record<string, AlignMode> = {
    w: 'top',
    s: 'bottom',
    a: 'left',
    d: 'right',
  };
  return modes[code];
}
