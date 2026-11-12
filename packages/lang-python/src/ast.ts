/** Python syntax tree (converted from the Lezer tree). `[start, end)` offsets. */

export interface Span {
  start: number;
  end: number;
}

export interface Param extends Span {
  /** Name including `*` / `**` for variadic parameters. */
  name: string;
  annotation?: Span;
  defaultValue?: Expr;
}

export interface Block extends Span {
  body: Stmt[];
  /** Body on the header line (`if x: return`). */
  inline: boolean;
  colonEnd: number;
}

export interface Arg extends Span {
  /** Keyword name for `f(key=value)`. */
  keyword?: string;
  /** `*args` / `**kwargs`. */
  star?: '*' | '**';
  value: Expr;
}

export type Expr =
  | ({ type: 'Name'; name: string } & Span)
  | ({
      type: 'Literal';
      kind: 'string' | 'bytes' | 'int' | 'float' | 'bool' | 'none';
      value: string;
    } & Span)
  | ({ type: 'FString'; parts: Expr[]; format: string } & Span)
  | ({ type: 'Attribute'; object: Expr; name: string } & Span)
  | ({ type: 'Subscript'; object: Expr; index: Expr } & Span)
  | ({ type: 'Call'; callee: Expr; args: Arg[] } & Span)
  | ({ type: 'Binary'; op: string; left: Expr; right: Expr } & Span)
  | ({ type: 'Unary'; op: string; argument: Expr } & Span)
  | ({
      type: 'Conditional';
      test: Expr;
      consequent: Expr;
      alternate: Expr;
    } & Span)
  | ({ type: 'Lambda'; params: Param[]; body: Expr } & Span)
  | ({
      type: 'Collection';
      kind: 'list' | 'tuple' | 'set';
      items: Expr[];
    } & Span)
  | ({
      type: 'Dict';
      entries: Array<{ key?: Expr; value: Expr }>;
    } & Span)
  | ({
      type: 'Comprehension';
      kind: 'list' | 'set' | 'dict' | 'generator';
      /** Expressions after each `in`. */
      sources: Expr[];
    } & Span)
  | ({ type: 'Await'; argument: Expr } & Span)
  | ({ type: 'Starred'; star: '*' | '**'; value: Expr } & Span)
  | ({ type: 'Paren'; expr: Expr } & Span)
  /** Anything else (walrus, yield expressions, slices, errors): shown as is. */
  | ({ type: 'Opaque'; nodeName: string } & Span);

export interface FunctionDef extends Span {
  type: 'FunctionDef';
  name: string;
  params: Param[];
  returns?: Span;
  body: Block;
  isAsync: boolean;
  decorators: Span[];
}

export interface ClassDef extends Span {
  type: 'ClassDef';
  name: string;
  bases: Arg[];
  body: Block;
  decorators: Span[];
}

export interface IfStmt extends Span {
  type: 'If';
  test: Expr;
  body: Block;
  elifs: Array<{ test: Expr; body: Block } & Span>;
  orelse?: Block;
}

export interface Handler extends Span {
  /** Exception type expression as written (e.g. `(KeyError, IndexError)`). */
  exception?: Expr;
  name?: string;
  body: Block;
}

export type Stmt =
  | FunctionDef
  | ClassDef
  | IfStmt
  | ({ type: 'Expr'; value: Expr } & Span)
  | ({
      type: 'Assign';
      targets: Expr[];
      value?: Expr;
      annotation?: Span;
    } & Span)
  | ({ type: 'AugAssign'; target: Expr; op: string; value: Expr } & Span)
  | ({
      type: 'For';
      target: Expr;
      iter: Expr;
      body: Block;
      orelse?: Block;
      isAsync: boolean;
    } & Span)
  | ({ type: 'While'; test: Expr; body: Block; orelse?: Block } & Span)
  | ({
      type: 'With';
      items: Array<{ context: Expr; target?: Expr }>;
      body: Block;
      isAsync: boolean;
    } & Span)
  | ({
      type: 'Try';
      body: Block;
      handlers: Handler[];
      orelse?: Block;
      finalbody?: Block;
    } & Span)
  | ({
      type: 'Match';
      subject: Expr;
      cases: Array<{ pattern: Span; body: Block } & Span>;
    } & Span)
  | ({ type: 'Return'; value?: Expr } & Span)
  | ({ type: 'Raise'; exception?: Expr; cause?: Expr } & Span)
  | ({ type: 'Assert'; test: Expr; message?: Expr } & Span)
  | ({ type: 'Delete'; targets: Expr[] } & Span)
  | ({ type: 'Yield'; value?: Expr } & Span)
  | ({ type: 'Pass' } & Span)
  | ({ type: 'Break' } & Span)
  | ({ type: 'Continue' } & Span)
  | ({ type: 'Import' } & Span)
  | ({ type: 'Scope' } & Span)
  | ({ type: 'Error'; nodeName: string } & Span);
