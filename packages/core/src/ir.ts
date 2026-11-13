/**
 * Language-agnostic graph intermediate representation (IR).
 *
 * Every language backend lowers its AST into this shape. Renderers, layout
 * and persistence only ever work with the IR, never with a language AST.
 */

import type { ScriptSymbol } from './symbols';

/** Half-open character offset range `[start, end)` into the source text. */
export interface SourceRange {
  start: number;
  end: number;
}

export interface Point {
  x: number;
  y: number;
}

export type PinKind = 'exec' | 'data';

export type PinDirection = 'in' | 'out';

export type PrimitiveType =
  | 'any'
  | 'bool'
  | 'number'
  | 'bigint'
  | 'string'
  | 'object'
  | 'array'
  | 'function'
  | 'null'
  | 'void'
  | 'regexp';

/**
 * A primitive type name or any other (named) type such as `Date` or `User`.
 */
export type DataType = PrimitiveType | (string & {});

export type LiteralKind =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'regexp'
  | 'template';

/** An inline value shown on an unconnected input pin (like UE default values). */
export interface PinLiteral {
  /** Human readable value (e.g. a string without quotes). */
  value: string;
  /** Raw source text of the literal. */
  raw: string;
  kind: LiteralKind;
  editable: boolean;
}

export interface Pin {
  /** Unique within its node. */
  id: string;
  /** Label rendered next to the pin. May be empty. */
  name: string;
  direction: PinDirection;
  kind: PinKind;
  type: DataType;
  /** Source range of the expression feeding (in) or produced by (out) this pin. */
  range?: SourceRange;
  literal?: PinLiteral;
  /** Backend specific information (e.g. insertion points for edits). */
  meta?: Record<string, unknown>;
}

export type NodeKind =
  | 'entry'
  | 'return'
  | 'call'
  | 'operator'
  | 'template'
  | 'literal'
  | 'makeObject'
  | 'makeArray'
  | 'getProperty'
  | 'getVar'
  | 'setVar'
  | 'functionRef'
  | 'branch'
  | 'switch'
  | 'forEach'
  | 'loop'
  | 'break'
  | 'continue'
  | 'try'
  | 'throw'
  | 'await'
  | 'select'
  /** Module export (`export default x`, `export { a, b }`). */
  | 'export'
  | 'unknown';

/** Controls the visual style (header color / shape) of a node. */
export type NodeCategory =
  | 'event'
  /** Start of a function (UE: the purple function entry node). */
  | 'entry'
  | 'function'
  | 'pure'
  | 'flow'
  | 'variable'
  | 'return'
  | 'latent'
  | 'unknown';

export type NodePurity = 'pure' | 'impure';

/** A code comment directly above a node's statement (UE comment bubble). */
export interface NodeComment {
  /** Comment text without comment markers. */
  text: string;
  /** Whole lines of the comment, including the final line break. */
  range: SourceRange;
  /** Written as a block comment (`/** … *\/`). */
  block?: boolean;
}

/**
 * A comment box around nodes (like UE's comment boxes), backed by a region
 * in the code (`// #region Title` … `// #endregion`).
 */
export interface CommentBox {
  id: string;
  title: string;
  /** From the start of the region marker line to the end of the end marker. */
  range: SourceRange;
  /** Title text in the start marker (empty when there is no title). */
  titleRange: SourceRange;
  /** The start and end marker comments. */
  markers: [SourceRange, SourceRange];
  /** Nodes inside the region. */
  nodes: string[];
}

export interface GraphNode {
  /** Stable id, see {@link createNodeId}. */
  id: string;
  kind: NodeKind;
  category: NodeCategory;
  purity: NodePurity;
  title: string;
  subtitle?: string;
  /** Render as a compact node (no header) like UE's variable getters. */
  compact?: boolean;
  range: SourceRange;
  pins: Pin[];
  /** Structural path within the function, used as a fallback identity. */
  path: string;
  /** Comment above the node's code, shown as a bubble. */
  comment?: NodeComment;
  meta?: Record<string, unknown>;
  /** Exists only in the graph, not in the code yet (`GraphOverlay`). */
  graphOnly?: boolean;
}

export interface PinRef {
  node: string;
  pin: string;
}

export type EdgeKind = PinKind;

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: PinRef;
  to: PinRef;
  /** A wire the code doesn't have yet (`GraphOverlay`). */
  graphOnly?: boolean;
}

export interface FunctionGraph {
  id: string;
  name: string;
  range: SourceRange;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Comment boxes (code regions) of this function. */
  comments?: CommentBox[];
}

export interface Diagnostic {
  message: string;
  range: SourceRange;
  severity: 'error' | 'warning';
}

export interface GraphDocument {
  language: string;
  functions: FunctionGraph[];
  diagnostics: Diagnostic[];
  /** Declarations of the script (functions, variables, types, …). */
  symbols?: ScriptSymbol[];
  /** Names exported from other modules (`export { a } from './x'`). */
  reexports?: Reexport[];
  /**
   * Settings of the whole script (UE's Class Settings), e.g. GDScript's
   * `@tool`, `class_name` and `extends`.
   */
  settings?: ScriptSetting[];
}

/** A setting of the whole script, edited with `setScriptSetting`. */
export interface ScriptSetting {
  id: string;
  label: string;
  /** A text field, or a switch (`value` is `true` / `false`). */
  kind: 'text' | 'flag';
  value: string;
  placeholder?: string;
}

/**
 * A re-export: `export { a as b } from './x'` (`imported` `a`, `name` `b`),
 * `export * from './x'` (both `*`), `export * as ns from './x'`, or a local
 * alias `export { a as b }` (no `module`).
 */
export interface Reexport {
  module?: string;
  imported: string;
  name: string;
}

export type Positions = Record<string, Point>;
