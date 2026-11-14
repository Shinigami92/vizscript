import type {
  Conversion,
  GraphEdge,
  GraphNode,
  GraphOp,
  LayoutPatch,
  LiteralKind,
  NodeGeometry,
  PinGeometry,
  PinRef,
  Point,
} from '@vizscript/core';
import type { BubbleLayout } from './bubble';
import type { Camera, Rect } from './camera';
import type { SelectionModifiers } from './selection';
import type { Theme } from './theme';

/** What a context menu was opened on. */
export type ContextTarget =
  | { kind: 'background' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'pin'; pin: PinRef }
  | { kind: 'wire'; edge: GraphEdge }
  | { kind: 'knot'; edgeId: string; index: number }
  | { kind: 'function'; fnId: string }
  | { kind: 'comment'; boxId: string; fnId: string };

/** A comment that can be edited in place. */
export type CommentTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'box'; boxId: string };

/** How `alignSelection` arranges the selected nodes (UE's alignment). */
export type AlignMode =
  | 'top'
  | 'middle'
  | 'bottom'
  | 'left'
  | 'center'
  | 'right'
  | 'distributeHorizontally'
  | 'distributeVertically'
  | 'straighten';

export interface GraphViewEvents {
  selectionChange: { nodeIds: string[] };
  hoverChange: { nodeId: string | null; pin: string | null };
  /**
   * Fired once at the end of a drag or when reroute points change. Node ids
   * map to positions; reroute keys (see `rerouteKey`) to knot positions.
   */
  layoutChange: { patch: LayoutPatch };
  op: GraphOp;
  editLiteral: {
    node: string;
    pin: string;
    value: string;
    kind: LiteralKind;
    /** Client (viewport) coordinates of the literal box. */
    rect: Rect;
  };
  contextMenu: {
    world: Point;
    client: Point;
    target: ContextTarget;
    /** Set when a wire dragged out of this pin was dropped on empty space. */
    from?: PinRef;
  };
  activate: { nodeId: string };
  /** A function's frame title was double-clicked (open it on its own). */
  openFunction: { fnId: string };
  /** Double-click on a comment bubble or comment box title. */
  editComment: {
    target: CommentTarget;
    value: string;
    /** Client (viewport) coordinates of the edited text. */
    rect: Rect;
  };
  cameraChange: Camera;
  message: { text: string };
}

export interface GraphViewOptions {
  /** Allow graph edits (wiring, deleting, literal edits). */
  editable?: boolean;
  theme?: Theme;
  /**
   * Ease camera moves (fit, zoom to selection, reveal) and nodes that move
   * because of an edit. Pass `false` for `prefers-reduced-motion: reduce`.
   */
  motion?: boolean;
  /**
   * Conversions of the file's language (UE's autocast): a wire between
   * pins of different types that one of them converts is allowed.
   */
  conversions?: () => ReadonlyArray<Conversion> | undefined;
}

/** A position change drawn as a short slide. */
export interface Tween<T> {
  from: T;
  to: T;
  start: number;
}

export interface NodeState {
  /** The node as drawn (advanced pins left out while folded). */
  node: GraphNode;
  /** The node with all its pins. */
  full: GraphNode;
  /** Number of advanced pins (UE's ▼ row when there are any). */
  advanced: number;
  fnId: string;
  geom: NodeGeometry;
  x: number;
  y: number;
  /** Comment bubble above the node. */
  bubble: BubbleLayout | null;
  /** The node slides to `tween.to`; `x` / `y` is where it is drawn now. */
  tween?: Tween<Point>;
  /** Start of the fade-in of a node that an edit added. */
  appear?: number;
  /** Start of the outline pulse after a jump to the node. */
  pulse?: number;
}

export interface FrameState {
  /** A function frame, or a comment box (code region) inside one. */
  kind: 'function' | 'comment';
  fnId: string;
  /** Comment box id (for `comment` frames). */
  boxId?: string;
  name: string;
  nodeIds: string[];
  bounds: Rect | null;
}

export type Hit =
  | { type: 'pin'; ns: NodeState; pg: PinGeometry }
  | { type: 'literal'; ns: NodeState; pg: PinGeometry }
  /** `advanced`: on the ▼ / ▲ row that folds advanced pins. */
  | { type: 'node'; ns: NodeState; advanced?: boolean }
  | { type: 'bubble'; ns: NodeState }
  | { type: 'knot'; edgeId: string; index: number }
  | { type: 'frame'; frame: FrameState };

export interface WireHit {
  edge: GraphEdge;
  /** Index of the wire segment (between two knots) that was hit. */
  segment: number;
}

export type Drag =
  | {
      type: 'pan';
      startClient: Point;
      startCamera: Camera;
      moved: boolean;
      button: number;
      tapNode: string | null;
    }
  | {
      type: 'nodes';
      ids: string[];
      startWorld: Point;
      origins: Map<string, Point>;
      knotOrigins: Map<string, Point>;
      moved: boolean;
    }
  | {
      type: 'marquee';
      startWorld: Point;
      currentWorld: Point;
      base: Set<string>;
      baseKnots: Set<string>;
      mods: SelectionModifiers;
    }
  | {
      type: 'wire';
      from: { ns: NodeState; pg: PinGeometry };
      currentWorld: Point;
      target: { ns: NodeState; pg: PinGeometry } | null;
      /** Why the pin under the cursor doesn't fit (UE's red ✕ message). */
      problem: string | null;
      /** The target input has a wire that the new one replaces. */
      replaces: boolean;
      /** Over empty space: dropping opens the actions for the pin. */
      empty: boolean;
      /** The conversion the wire goes through (UE's autocast node). */
      convert: Conversion | null;
    }
  | {
      /** Ctrl+drag of a pin: all its wires move to another pin (UE). */
      type: 'moveWires';
      from: { ns: NodeState; pg: PinGeometry };
      /** The other ends of the moved wires. */
      ends: Array<{ ns: NodeState; pg: PinGeometry }>;
      currentWorld: Point;
      target: { ns: NodeState; pg: PinGeometry } | null;
      problem: string | null;
    }
  | {
      type: 'pinch';
      startDistance: number;
      startMid: Point;
      startCamera: Camera;
    };

/**
 * A node's banner: a problem of the code (ERROR! / WARNING! / NOTE), or
 * `sync` for a node the code doesn't match yet (graph-only edits).
 */
export type NodeBannerKind = 'error' | 'warning' | 'info' | 'sync';
