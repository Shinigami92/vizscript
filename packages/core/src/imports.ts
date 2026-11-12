import type { GraphDocument, Reexport, SourceRange } from './ir';
import type { ScriptSymbol, SymbolParam, TypeRef } from './symbols';

/**
 * What an import of the parsed file refers to, read from the imported file:
 * the declaration of an imported name, or the exports of a whole module
 * (`import * as ns`, Python's `import mod`, a GDScript preload).
 */
export interface ImportedDeclaration {
  /** Local name of the import in the parsed file. */
  name: string;
  declaration?: ScriptSymbol;
  members?: ReadonlyArray<ScriptSymbol>;
}

/**
 * A name of another repository file to import, so a node can use it. The
 * backend writes the import in its own syntax (`import { a } from './x'`,
 * `from x import a`, `const A = preload("res://a.gd")`).
 */
export interface ImportRequest {
  /** Repository path of the file that declares the name. */
  path: string;
  /** Repository path of the file that gets the import. */
  from: string;
  /** Local name in the importing file. */
  name: string;
  /** Exported name, `default`, or `*` for the whole module or script. */
  imported: string;
  /** Project root for root paths (GDScript's `res://`), `''` for the repo. */
  root?: string;
  /**
   * Module as written, for libraries (`vue`, `math`); `path` and `from`
   * are not used then.
   */
  module?: string;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** `to` relative to the directory of `from`: `./x.ts`, `../a/x.ts`. */
export function relativePath(from: string, to: string): string {
  const fromParts = dirname(from).split('/').filter(Boolean);
  const toParts = to.split('/');
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const up = fromParts.length - common;
  const rest = toParts.slice(common).join('/');
  return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`;
}

/** Context of a parse beyond the file itself. */
export interface ParseOptions {
  imports?: ReadonlyArray<ImportedDeclaration>;
}

const NOWHERE: SourceRange = { start: 0, end: 0 };

function portableType(type: TypeRef | undefined): TypeRef | undefined {
  return type ? { text: type.text, range: NOWHERE } : undefined;
}

function portableParam(param: SymbolParam, text: string): SymbolParam {
  const { defaultRange, type, ...rest } = param;
  const defaultText = defaultRange
    ? text.slice(defaultRange.start, defaultRange.end)
    : param.defaultText;
  const typeRef = portableType(type);
  return {
    ...rest,
    nameRange: NOWHERE,
    ...(typeRef ? { type: typeRef } : {}),
    ...(defaultText === undefined ? {} : { defaultText }),
  };
}

/**
 * A declaration of another file, usable in this one: ranges point nowhere
 * (they belong to the other file's text), default values become text.
 */
function portable(symbol: ScriptSymbol, text: string): ScriptSymbol {
  const {
    defaultRange: _defaultRange,
    declarationRange: _declarationRange,
    graphStart: _graphStart,
    fnId: _fnId,
    type,
    returns,
    params,
    ...rest
  } = symbol;
  const portableTypeRef = portableType(type);
  const portableReturns = portableType(returns);
  return {
    ...rest,
    range: NOWHERE,
    nameRange: NOWHERE,
    ...(portableTypeRef ? { type: portableTypeRef } : {}),
    ...(portableReturns ? { returns: portableReturns } : {}),
    ...(params ? { params: params.map((p) => portableParam(p, text)) } : {}),
  };
}

const MEMBER_KINDS = new Set([
  'function',
  'class',
  'variable',
  'constant',
  'type',
  'enum',
  'signal',
]);

/**
 * What other files can import from a parsed file, by the rules of its
 * language: TypeScript's `export`s, Python's public module names (no `_`),
 * every member of a GDScript script, Rust's `pub` items.
 */
export function exportedSymbols(
  doc: GraphDocument,
  text: string
): ScriptSymbol[] {
  return (doc.symbols ?? [])
    .filter((symbol) => {
      if (symbol.scope !== '' || !MEMBER_KINDS.has(symbol.kind)) {
        return false;
      }

      switch (doc.language) {
        case 'python': {
          return !symbol.name.startsWith('_');
        }

        case 'gdscript': {
          return true;
        }

        case 'rust': {
          return symbol.modifiers.some((m) => m.startsWith('pub'));
        }

        default: {
          return symbol.modifiers.some((m) => m.startsWith('export'));
        }
      }
    })
    .map((symbol) => portable(symbol, text));
}

/**
 * Exports of a module including what it re-exports: `resolve` returns the
 * exports of another module (already followed), or nothing when unknown.
 */
export async function withReexports(
  exports: ReadonlyArray<ScriptSymbol>,
  reexports: ReadonlyArray<Reexport>,
  resolve: (module: string) => Promise<ReadonlyArray<ScriptSymbol>>
): Promise<ScriptSymbol[]> {
  const result = [...exports];
  const names = new Set(result.map((s) => s.name));
  const add = (symbol: ScriptSymbol, name: string): void => {
    if (!names.has(name)) {
      names.add(name);
      result.push(name === symbol.name ? symbol : { ...symbol, name });
    }
  };

  for (const reexport of reexports) {
    const from = reexport.module ? await resolve(reexport.module) : exports;
    if (reexport.imported === '*' && reexport.name === '*') {
      // `export *` leaves out the default export.
      for (const symbol of from) {
        if (!symbol.modifiers.includes('export default')) {
          add(symbol, symbol.name);
        }
      }
    } else if (reexport.imported !== '*') {
      const symbol =
        reexport.imported === 'default'
          ? defaultExport(from)
          : from.find((s) => s.name === reexport.imported);
      if (symbol) {
        add(
          reexport.name === 'default'
            ? { ...symbol, modifiers: [...symbol.modifiers, 'export default'] }
            : symbol,
          reexport.name === 'default' ? symbol.name : reexport.name
        );
      }
    }
  }

  return result;
}

/** The default export (`export default function …`). */
export function defaultExport(
  exports: ReadonlyArray<ScriptSymbol>
): ScriptSymbol | undefined {
  return exports.find((s) => s.modifiers.includes('export default'));
}

/**
 * Gives the import symbols of a document what their declarations say:
 * kind, inputs, output and type, like UE shows a function of another
 * Blueprint. Gets of imported constants and variables get their type.
 */
export function linkImports(
  doc: GraphDocument,
  imports: ReadonlyArray<ImportedDeclaration> | undefined
): void {
  if (!imports || imports.length === 0) {
    return;
  }

  const byName = new Map(imports.map((i) => [i.name, i]));
  for (const symbol of doc.symbols ?? []) {
    const declaration =
      symbol.kind === 'import'
        ? byName.get(symbol.name)?.declaration
        : undefined;
    if (!declaration) {
      continue;
    }

    symbol.importedKind = declaration.kind;
    symbol.dataType = declaration.dataType;
    if (declaration.type) {
      symbol.type = declaration.type;
    }

    if (declaration.params) {
      symbol.params = declaration.params;
    }

    if (declaration.returns) {
      symbol.returns = declaration.returns;
    }

    if (declaration.returnType !== undefined) {
      symbol.returnType = declaration.returnType;
    }
  }

  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      const declaration =
        node.kind === 'getVar'
          ? byName.get(node.title)?.declaration
          : undefined;
      if (
        !declaration ||
        (declaration.kind !== 'variable' && declaration.kind !== 'constant')
      ) {
        continue;
      }

      for (const pin of node.pins) {
        if (
          pin.direction === 'out' &&
          pin.kind === 'data' &&
          pin.type === 'any'
        ) {
          pin.type = declaration.dataType;
        }
      }
    }
  }
}
