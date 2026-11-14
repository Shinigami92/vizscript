import type { Camera, GraphView, GraphViewEvents } from '@vizscript/canvas';
import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  NodeTemplate,
  Pin,
  PinRef,
  Point,
  Positions,
  TypeSystemInfo,
} from '@vizscript/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { DocIndex } from '../../graph/doc-index';
import type { Problem } from '../../graph/problems';
import type { ExternalName } from '../../graph/project-index';

export interface GraphCanvasProps {
  doc: GraphDocument | null;
  positions: Positions;
  editable: boolean;
  text: string;
  initialCamera?: Camera | null;
  /** Describes where "Go to definition" of a node leads, if anywhere. */
  definitionOf?: (nodeId: string) => string | undefined;
  /**
   * Where a graph is used, for its entry node: the callback node or the
   * calls of the function (the way back from Go to definition).
   */
  usagesOf?: (
    entryId: string
  ) => ReadonlyArray<{ nodeId: string; label: string }>;
  /** Problems per node, shown as ERROR / WARNING banners. */
  problems?: ReadonlyMap<string, ReadonlyArray<Problem>>;
  /** Nodes the code doesn't match yet (graph-only edits). */
  syncNodes?: ReadonlySet<string>;
  /** Names imported into the file (offered in the action menu). */
  imports?: ReadonlyArray<string>;
  /** Operators and values of the language (action menu). */
  types?: TypeSystemInfo | null;
  /** Names of other files; using one adds its import. */
  externals?: ReadonlyArray<ExternalName>;
}

export type MenuState = GraphViewEvents['contextMenu'];

/** A one-field form that replaces the menu list (names, expressions). */
export interface Prompt {
  label: string;
  placeholder: string;
  value: string;
  /** Submit an empty value too (otherwise Enter does nothing). */
  allowEmpty?: boolean;
  submit: (value: string) => void;
}

export type PromptOptions = Omit<Prompt, 'value'> & { value?: string };

/** Where new code for a point of the graph goes. */
export interface Place {
  fnId: string;
  anchor: { after: PinRef } | { before: PinRef };
}

/** What the menu builders and composables of the canvas share. */
export interface CanvasContext {
  readonly props: Readonly<GraphCanvasProps>;
  readonly view: ShallowRef<GraphView | undefined>;
  readonly canvas: Readonly<ShallowRef<HTMLCanvasElement | null>>;
  readonly index: ComputedRef<DocIndex>;
  readonly selection: Ref<string[]>;
  /** Functions worth offering: called in this file, defined, or imported. */
  readonly callables: ComputedRef<ReadonlyArray<string>>;
  /** Names of other files and libraries not offered as callables already. */
  readonly externalNames: ComputedRef<ReadonlyArray<ExternalName>>;
  /** Emits an op (placed where the menu opened) and closes the menu. */
  emitOp: (op: GraphOp) => void;
  show: (message: string, kind?: 'info' | 'error') => void;
  /** Replaces the menu list with a one-field form. */
  ask: (options: PromptOptions) => Promise<void>;
  /** Adds a node at the pin or point a menu opened for. */
  addNode: (
    template: NodeTemplate,
    state: MenuState | null,
    wrap?: (op: GraphOp) => GraphOp
  ) => void;
  /**
   * Where new code for a point of the graph goes: the end of the function
   * whose frame contains it (else the module).
   */
  placeAt: (world: Point) => Place | undefined;
  pinOf: (pinRef: PinRef) => { node: GraphNode; pin: Pin } | undefined;
}

/** Events of the canvas the context menu entries emit. */
export interface CanvasEvents {
  op: (op: GraphOp) => void;
  activate: (id: string) => void;
  goToDefinition: (id: string) => void;
  /** Shows a node of any function (switching the focused graph). */
  jumpTo: (id: string) => void;
  resetLayout: (ids: string[]) => void;
  openFunction: (fnId: string) => void;
}
