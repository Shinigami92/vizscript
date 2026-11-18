import type { Conversion, PinGeometry, Point } from '@vizscript/core';
import type { Camera } from './camera';
import type {
  AlignMode,
  CommentTarget,
  GraphViewEvents,
  Hit,
  NodeState,
} from './graph-view-types';
import type { Interaction } from './interaction';
import type { Scene } from './scene';
import type { Viewport } from './viewport';

/** What the `Controller` reads and changes of the view it drives. */
export interface ControllerHost {
  readonly canvas: HTMLCanvasElement;
  readonly scene: Scene;
  readonly viewport: Viewport;
  readonly ui: Interaction;
  editable(): boolean;
  conversions(): ReadonlyArray<Conversion> | undefined;
  emit<K extends keyof GraphViewEvents>(
    event: K,
    payload: GraphViewEvents[K]
  ): void;
  requestRender(): void;
  hitTest(world: Point): Hit | null;
  /** Selects nodes (`selectionChange` when it changed). */
  setSelection(selection: Set<string>): void;
  setHover(nodeId: string | null, pin: string | null): void;
  setHoverEdge(edgeId: string | null): void;
  setHoverAddPin(nodeId: string | null): void;
  /** Sets the camera at once, ending any easing (`cameraChange`). */
  setCamera(camera: Camera): void;
  finishNodeMoves(): void;
  toggleAdvanced(ns: NodeState): void;
  getReroutes(edgeId: string): Point[];
  addReroute(edgeId: string, world: Point): void;
  removeReroute(edgeId: string, index: number): void;
  deleteSelectedKnots(): void;
  editComment(target: CommentTarget): void;
  startLiteralEdit(ns: NodeState, pg: PinGeometry): void;
  selectAll(): void;
  alignSelection(mode: AlignMode): void;
  frameSelection(): void;
  frameAll(): void;
}
