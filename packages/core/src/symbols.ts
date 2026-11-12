import type { DataType, GraphDocument, SourceRange } from './ir';

/**
 * What a script declares, like the sections of UE's "My Blueprint" panel.
 * `variable` and `constant` live in the module or a class, `local` in a
 * function. `import` is a name bound by an import (or a GDScript preload).
 */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'variable'
  | 'constant'
  | 'local'
  | 'type'
  | 'enum'
  | 'signal'
  | 'import';

/** A type annotation as written in the code. */
export interface TypeRef {
  text: string;
  range: SourceRange;
}

/** A parameter of a function, method or signal. */
export interface SymbolParam {
  name: string;
  nameRange: SourceRange;
  /** Declared type; missing when untyped. */
  type?: TypeRef;
  /** Pin type (declared, or inferred from the default value). */
  dataType: DataType;
  /** Default value expression. */
  defaultRange?: SourceRange;
  /** Default value of a parameter declared in another file. */
  defaultText?: string;
  /** `...rest`, `*args`, `**kwargs`. */
  rest?: boolean;
}

/** A declaration of the script (UE: an entry of "My Blueprint"). */
export interface ScriptSymbol {
  /** `kind:qualified.name`, unique within the document. */
  id: string;
  kind: SymbolKind;
  name: string;
  /** Qualified name of the owner (class or function); `''` for the module. */
  scope: string;
  /** The whole declaration. */
  range: SourceRange;
  /**
   * The statement to delete with the symbol when it is more than `range`
   * (`export const a = 1;` around the declarator `a = 1`). Symbols that
   * share it were declared together (`let a, b;`).
   */
  declarationRange?: SourceRange;
  nameRange: SourceRange;
  /** Declared type of a variable; missing when untyped. */
  type?: TypeRef;
  /** Pin type: declared, inferred from the value, or `any`. */
  dataType: DataType;
  /** Initial or default value expression. */
  defaultRange?: SourceRange;
  /**
   * Keywords and annotations as written, e.g. `export`, `const`, `let`,
   * `static`, `async`, `private`, `@export`, `@onready`.
   */
  modifiers: string[];
  /** Inputs of functions, methods and signals. */
  params?: SymbolParam[];
  /** Declared return type. */
  returns?: TypeRef;
  returnType?: DataType;
  /** `extends` / base classes of a class. */
  extends?: string;
  /** Start offset of the code that became a function graph. */
  graphStart?: number;
  /** The function graph of a function, method or class. */
  fnId?: string;
  /** Module of an import, as written (`./util`, `os.path`, `res://x.gd`). */
  module?: string;
  /**
   * What an import takes from its module: the exported name, `default`, or
   * `*` for the whole module (`import * as ns`, `import os`, a preload).
   */
  imported?: string;
  /** Kind of the imported declaration, once its file was read. */
  importedKind?: SymbolKind;
}

/** Qualified name of a symbol, e.g. `Item.total`. */
export function qualifiedName(symbol: ScriptSymbol): string {
  return symbol.scope ? `${symbol.scope}.${symbol.name}` : symbol.name;
}

/** Builds the id of a symbol. */
export function symbolId(
  kind: SymbolKind,
  scope: string,
  name: string
): string {
  return `${kind}:${scope ? `${scope}.` : ''}${name}`;
}

/**
 * Links functions, methods and classes to their function graphs: by the
 * start of their code, else by the graph's (qualified) name.
 */
export function linkSymbolGraphs(doc: GraphDocument): void {
  const byStart = new Map(doc.functions.map((f) => [f.range.start, f.id]));
  const byName = new Map(doc.functions.map((f) => [f.name, f.id]));
  for (const symbol of doc.symbols ?? []) {
    if (
      symbol.kind !== 'function' &&
      symbol.kind !== 'method' &&
      symbol.kind !== 'class'
    ) {
      continue;
    }

    symbol.fnId =
      (symbol.graphStart === undefined
        ? undefined
        : byStart.get(symbol.graphStart)) ?? byName.get(qualifiedName(symbol));
  }
}
