import type { GraphEdge, PinGeometry } from '@vizscript/core';
import { isChecked } from './graph-view-constants';
import type { FrameState, Hit, NodeState } from './graph-view-types';

/** A press of a pointer, with what is under it. */
export interface PointerPress {
  hit: Hit | null;
  button: number;
  pointerType: string;
  /** Space held: the left button pans, like UE. */
  spaceDown: boolean;
  shift: boolean;
  /** Ctrl, or ⌘ on macOS. */
  ctrl: boolean;
  alt: boolean;
  editable: boolean;
  /** The other ends of the hit pin's wires (Ctrl+drag picks them up). */
  wireEnds: () => ReadonlyArray<{ ns: NodeState; pg: PinGeometry }>;
  /** The wire under the pointer, for Alt+click on empty space. */
  wireAt: () => GraphEdge | null;
}

/** What a press starts; `onPointerDown` carries it out. */
export type PointerIntent =
  | { type: 'none' }
  /** Pan the view; a tap on a node (touch, middle, right) acts on it. */
  | { type: 'pan'; tapNode: string | null }
  | { type: 'removeKnot'; edgeId: string; index: number }
  /** Select (with the modifiers) and drag a reroute point. */
  | { type: 'knot'; edgeId: string; index: number }
  | { type: 'toggleAdvanced'; ns: NodeState }
  | { type: 'addArgument'; nodeId: string }
  | { type: 'disconnectPin'; node: string; pin: string }
  /** Ctrl+drag: the pin's wires move to another pin. */
  | {
      type: 'moveWires';
      from: { ns: NodeState; pg: PinGeometry };
      ends: ReadonlyArray<{ ns: NodeState; pg: PinGeometry }>;
    }
  | { type: 'wire'; from: { ns: NodeState; pg: PinGeometry } }
  | { type: 'toggleCheckbox'; node: string; pin: string; value: string }
  /** Select (with the modifiers) and drag a node. */
  | { type: 'node'; nodeId: string }
  /** Select (with the modifiers) and drag the nodes of a frame. */
  | { type: 'frame'; frame: FrameState }
  | { type: 'breakWire'; edge: GraphEdge }
  | { type: 'marquee' };

/**
 * What a single pointer press starts, like UE: the middle or right button,
 * Space + left or a touch pans; on the left button a reroute point, the ▼
 * row, "Add pin +", a pin (Alt: break its wires, Ctrl: move them), a
 * checkbox, a node, a frame header, Alt + a wire (break it), else a
 * marquee.
 */
export function classifyPointerDown(press: PointerPress): PointerIntent {
  const { hit } = press;
  if (
    press.button === 1 ||
    press.button === 2 ||
    (press.button === 0 && press.spaceDown) ||
    press.pointerType === 'touch'
  ) {
    return {
      type: 'pan',
      tapNode:
        hit &&
        (hit.type === 'node' ||
          hit.type === 'bubble' ||
          hit.type === 'pin' ||
          hit.type === 'literal')
          ? hit.ns.node.id
          : null,
    };
  }

  if (press.button !== 0) {
    return { type: 'none' };
  }

  switch (hit?.type) {
    case 'knot': {
      return press.alt
        ? { type: 'removeKnot', edgeId: hit.edgeId, index: hit.index }
        : { type: 'knot', edgeId: hit.edgeId, index: hit.index };
    }

    case 'node': {
      if (hit.advanced) {
        return { type: 'toggleAdvanced', ns: hit.ns };
      }

      // UE's "Add pin +": one more argument.
      if (hit.addPin) {
        return { type: 'addArgument', nodeId: hit.ns.node.id };
      }

      return { type: 'node', nodeId: hit.ns.node.id };
    }

    case 'pin': {
      if (!press.editable) {
        return { type: 'node', nodeId: hit.ns.node.id };
      }

      if (press.alt) {
        return {
          type: 'disconnectPin',
          node: hit.ns.node.id,
          pin: hit.pg.pin.id,
        };
      }

      // Like UE: Ctrl+drag picks up all wires of the pin.
      const ends = press.ctrl ? press.wireEnds() : [];
      const from = { ns: hit.ns, pg: hit.pg };
      return ends.length > 0
        ? { type: 'moveWires', from, ends }
        : { type: 'wire', from };
    }

    case 'literal': {
      // Like UE: a boolean value is a checkbox that toggles on click.
      const literal = hit.pg.pin.literal;
      if (press.editable && literal?.kind === 'boolean') {
        return {
          type: 'toggleCheckbox',
          node: hit.ns.node.id,
          pin: hit.pg.pin.id,
          value: isChecked(literal.value) ? 'false' : 'true',
        };
      }

      return { type: 'node', nodeId: hit.ns.node.id };
    }

    case 'bubble': {
      return { type: 'node', nodeId: hit.ns.node.id };
    }

    case 'frame': {
      return { type: 'frame', frame: hit.frame };
    }

    case undefined: {
      // Like UE: Alt + click breaks a wire.
      const wire = press.alt && press.editable ? press.wireAt() : null;
      return wire ? { type: 'breakWire', edge: wire } : { type: 'marquee' };
    }
  }
}
