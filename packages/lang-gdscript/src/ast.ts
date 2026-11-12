/** GDScript syntax tree. Every node has `[start, end)` source offsets. */

export interface Span {
  start: number;
  end: number;
}

export interface TypeRef extends Span {
  /** Type as written, e.g. `int`, `Array[Node]`, `Vector3`. */
  name: string;
}

export interface Param extends Span {
  name: string;
  type?: TypeRef;
  /** `:=` (type inferred from the default). */
  inferred: boolean;
  defaultValue?: Expr;
}

export interface Block extends Span {
  body: Stmt[];
  /** Body on the same line as the header (`if x: return`). */
  inline: boolean;
  /** End of the header's `:` token. */
  colonEnd: number;
}

// ------------------------------------------------------------ expressions

export type Expr =
  | ({ type: 'Literal'; kind: LiteralKind; value: string } & Span)
  | ({ type: 'Identifier'; name: string } & Span)
  | ({ type: 'Self' } & Span)
  | ({ type: 'Super' } & Span)
  | ({ type: 'NodePath'; path: string; unique: boolean } & Span)
  | ({ type: 'Binary'; op: string; left: Expr; right: Expr } & Span)
  | ({ type: 'Unary'; op: string; argument: Expr } & Span)
  | ({
      type: 'Ternary';
      test: Expr;
      consequent: Expr;
      alternate: Expr;
    } & Span)
  | ({ type: 'Cast'; expr: Expr; target: TypeRef } & Span)
  | ({ type: 'Is'; expr: Expr; target: TypeRef; negated: boolean } & Span)
  | ({ type: 'Call'; callee: Expr; args: Expr[] } & Span)
  | ({ type: 'Attribute'; object: Expr; name: string; nameSpan: Span } & Span)
  | ({ type: 'Subscript'; object: Expr; index: Expr } & Span)
  | ({ type: 'Array'; elements: Expr[] } & Span)
  | ({
      type: 'Dictionary';
      entries: Array<{ key: Expr; value: Expr; luaStyle: boolean }>;
    } & Span)
  | ({ type: 'Await'; argument: Expr } & Span)
  | ({ type: 'Paren'; expr: Expr } & Span)
  | ({ type: 'Lambda'; fn: FuncDecl } & Span)
  | ({ type: 'Error' } & Span);

export type LiteralKind =
  | 'string'
  | 'stringName'
  | 'nodePath'
  | 'int'
  | 'float'
  | 'bool'
  | 'null';

// ------------------------------------------------------------- statements

export interface VarDecl extends Span {
  type: 'Var';
  kind: 'var' | 'const';
  name: string;
  nameSpan: Span;
  typeRef?: TypeRef;
  inferred: boolean;
  value?: Expr;
  isStatic: boolean;
  annotations: Annotation[];
  /** Property accessors (`set(value):` / `get:` blocks). */
  setter?: FuncDecl;
  getter?: FuncDecl;
}

export interface Annotation extends Span {
  name: string;
  args: Expr[];
}

export interface FuncDecl extends Span {
  type: 'Func';
  name: string | null;
  params: Param[];
  returnType?: TypeRef;
  body: Block;
  isStatic: boolean;
  annotations: Annotation[];
}

export interface IfStmt extends Span {
  type: 'If';
  test: Expr;
  body: Block;
  /** `elif` parts, each starting at its keyword. */
  elifs: Array<{ test: Expr; body: Block } & Span>;
  orelse?: Block;
}

export interface MatchBranch extends Span {
  /** Pattern(s) and guard as written, up to the `:`. */
  patterns: Span;
  body: Block;
}

export type Stmt =
  | VarDecl
  | FuncDecl
  | IfStmt
  | ({ type: 'Expr'; expr: Expr } & Span)
  | ({ type: 'Assign'; target: Expr; op: string; value: Expr } & Span)
  | ({
      type: 'For';
      variable: string;
      variableSpan: Span;
      variableType?: TypeRef;
      iterable: Expr;
      body: Block;
    } & Span)
  | ({ type: 'While'; test: Expr; body: Block } & Span)
  | ({ type: 'Match'; subject: Expr; branches: MatchBranch[] } & Span)
  | ({ type: 'Return'; value?: Expr } & Span)
  | ({ type: 'Break' } & Span)
  | ({ type: 'Continue' } & Span)
  | ({ type: 'Pass' } & Span)
  | ({ type: 'Breakpoint' } & Span)
  | ({ type: 'Signal'; name: string; params: Param[] } & Span)
  | ({ type: 'Enum'; name: string | null } & Span)
  | ({ type: 'Extends'; target: string } & Span)
  | ({ type: 'ClassName'; name: string } & Span)
  | ({ type: 'Class'; name: string; extends?: string; body: Block } & Span)
  | ({ type: 'Annotation'; annotation: Annotation } & Span)
  | ({ type: 'Error'; message: string } & Span);

export interface Script {
  body: Stmt[];
  className?: string;
  extendsName?: string;
}
