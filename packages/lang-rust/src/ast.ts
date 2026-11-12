/** Rust syntax tree (converted from the Lezer tree). `[start, end)` offsets. */

export interface Span {
  start: number;
  end: number;
}

export interface Param extends Span {
  /** Bound name (`x` of `mut x: i32`); missing for patterns. */
  name?: string;
  /** The pattern as written (`x`, `(a, b)`, `_`). */
  pattern: Span;
  type?: Span;
  mutable: boolean;
}

/** `self`, `&self`, `&mut self`, `mut self`. */
export interface SelfParam extends Span {
  text: string;
}

export interface Block extends Span {
  body: Stmt[];
  /** Offset right after `{`. */
  open: number;
  /** Offset of `}`. */
  close: number;
}

export interface FieldInit extends Span {
  /** Field name (`x` of `x: 1` or the shorthand `x`). */
  name: string;
  nameSpan: Span;
  /** Missing for shorthands (`Point { x }`). */
  value?: Expr;
}

/** A pattern binding with the names it introduces (`Some(x)` → `x`). */
export interface Pattern extends Span {
  /** Names bound by the pattern, in order. */
  bindings: Array<{ name: string } & Span>;
  /** Just one name (`x`, `mut x`). */
  simple?: string;
}

export type Expr =
  | ({ type: 'Name'; name: string } & Span)
  | ({
      type: 'Literal';
      kind: 'string' | 'char' | 'bytes' | 'int' | 'float' | 'bool' | 'unit';
      value: string;
    } & Span)
  | ({ type: 'Field'; object: Expr; name: string } & Span)
  | ({ type: 'Index'; object: Expr; index: Expr } & Span)
  | ({
      type: 'Call';
      callee: Expr;
      args: Expr[];
      /** `::<T>` of `collect::<Vec<_>>()`. */
      turbofish?: Span;
      /** Offsets of `(` + 1 and `)`. */
      open: number;
      close: number;
    } & Span)
  | ({
      type: 'Macro';
      name: string;
      /** Arguments, when the macro takes expressions (`println!`, `vec!`). */
      args?: Expr[];
      /** `vec![value; count]`. */
      repeat?: boolean;
      /** Offsets right after the opening delimiter and of the closing one. */
      open: number;
      close: number;
    } & Span)
  | ({ type: 'Binary'; op: string; left: Expr; right: Expr } & Span)
  | ({ type: 'Unary'; op: string; argument: Expr } & Span)
  | ({ type: 'Ref'; mutable: boolean; argument: Expr } & Span)
  | ({ type: 'Cast'; value: Expr; target: Span } & Span)
  | ({ type: 'Range'; op: string; from?: Expr; to?: Expr } & Span)
  | ({ type: 'Try'; value: Expr } & Span)
  | ({ type: 'Await'; value: Expr } & Span)
  | ({
      type: 'Struct';
      name: string;
      fields: FieldInit[];
      /** `..base` */
      base?: Expr;
    } & Span)
  | ({ type: 'Array'; items: Expr[]; repeat?: boolean } & Span)
  | ({ type: 'Tuple'; items: Expr[] } & Span)
  | ({
      type: 'Closure';
      params: Param[];
      body: Expr | Block;
      isAsync: boolean;
      isMove: boolean;
      returns?: Span;
    } & Span)
  | ({ type: 'If'; stmt: IfStmt } & Span)
  | ({ type: 'Match'; stmt: MatchStmt } & Span)
  | ({ type: 'Block'; block: Block; label: string } & Span)
  | ({ type: 'Paren'; expr: Expr } & Span)
  /** `let Some(x) = value` in a condition. */
  | ({ type: 'Let'; pattern: Pattern; value: Expr } & Span)
  /** Conditions joined with `&&` that contain a `let` (a let chain). */
  | ({ type: 'LetChain'; parts: Expr[] } & Span)
  /** Anything else (loops as values, errors …): shown as is. */
  | ({ type: 'Opaque'; nodeName: string } & Span);

export interface IfStmt extends Span {
  type: 'If';
  condition: Expr;
  body: Block;
  elifs: Array<{ condition: Expr; body: Block } & Span>;
  orelse?: Block;
}

export interface MatchArm extends Span {
  pattern: Pattern;
  guard?: Expr;
  /** A block, or an expression (`Some(v) => v + 1`). */
  body: Block | Expr;
}

export interface MatchStmt extends Span {
  type: 'Match';
  subject: Expr;
  arms: MatchArm[];
}

export interface FunctionItem extends Span {
  type: 'Function';
  name: string;
  nameSpan: Span;
  /** `pub`, `pub(crate)`, `async`, `const`, `unsafe`, `extern "C"`. */
  modifiers: string[];
  /** Where the modifiers (or `fn`) start, after attributes. */
  headStart: number;
  self?: SelfParam;
  params: Param[];
  /** Range of `(…)`. */
  paramList: Span;
  returns?: Span;
  /** Missing in traits (`fn area(&self) -> f64;`). */
  body?: Block;
  attributes: Span[];
}

export interface StructItem extends Span {
  type: 'Struct';
  name: string;
  nameSpan: Span;
  modifiers: string[];
  fields: Array<
    {
      name: string;
      nameSpan: Span;
      type: Span;
      modifiers: string[];
    } & Span
  >;
  /** `struct A(i32, String);` */
  tuple: boolean;
  /** Offsets of the braces of `{ fields }`. */
  open?: number;
  close?: number;
  attributes: Span[];
}

export interface EnumItem extends Span {
  type: 'Enum';
  name: string;
  nameSpan: Span;
  modifiers: string[];
  variants: string[];
  attributes: Span[];
}

export interface ImplItem extends Span {
  type: 'Impl';
  /** The type the impl is for (`Point` of `impl Area for Point<T>`). */
  target: string;
  trait?: string;
  items: Item[];
  open: number;
  close: number;
}

export interface TraitItem extends Span {
  type: 'Trait';
  name: string;
  nameSpan: Span;
  modifiers: string[];
  items: Item[];
  attributes: Span[];
}

export interface ValueItem extends Span {
  type: 'Const' | 'Static';
  name: string;
  nameSpan: Span;
  modifiers: string[];
  mutable: boolean;
  valueType?: Span;
  value?: Expr;
  attributes: Span[];
}

export interface ModItem extends Span {
  type: 'Mod';
  name: string;
  nameSpan: Span;
  /** Inline modules (`mod tests { … }`). */
  items?: Item[];
}

export interface UseItem extends Span {
  type: 'Use';
}

export interface TypeAliasItem extends Span {
  type: 'TypeAlias';
  name: string;
  nameSpan: Span;
  modifiers: string[];
  value?: Span;
}

export type Item =
  | FunctionItem
  | StructItem
  | EnumItem
  | ImplItem
  | TraitItem
  | ValueItem
  | ModItem
  | UseItem
  | TypeAliasItem
  /** Macro definitions, extern blocks, … */
  | ({ type: 'OtherItem'; nodeName: string } & Span);

export type Stmt =
  | ({ type: 'Item'; item: Item } & Span)
  | ({
      type: 'Let';
      pattern: Pattern;
      mutable: boolean;
      valueType?: Span;
      value?: Expr;
      /** `let Some(x) = opt else { … };` */
      orelse?: Block;
    } & Span)
  | ({
      type: 'Expr';
      value: Expr;
      /** Ends with `;` (else it's the block's value, or a block-like one). */
      semicolon: boolean;
    } & Span)
  | ({
      type: 'Assign';
      target: Expr;
      /** `=`, `+=`, `-=` … */
      op: string;
      value: Expr;
    } & Span)
  | IfStmt
  | MatchStmt
  | ({
      type: 'For';
      pattern: Pattern;
      iter: Expr;
      body: Block;
      label?: string;
    } & Span)
  | ({ type: 'While'; condition: Expr; body: Block; label?: string } & Span)
  | ({ type: 'Loop'; body: Block; label?: string } & Span)
  | ({ type: 'Return'; value?: Expr } & Span)
  | ({ type: 'Break'; label?: string; value?: Expr } & Span)
  | ({ type: 'Continue'; label?: string } & Span)
  /** `{ … }`, `unsafe { … }`, `async { … }` as a statement. */
  | ({ type: 'BlockStmt'; block: Block; label: string } & Span)
  | ({ type: 'Empty' } & Span)
  | ({ type: 'Error'; nodeName: string } & Span);
