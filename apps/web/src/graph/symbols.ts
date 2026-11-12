import type {
  FunctionGraph,
  GraphDocument,
  PinRef,
  ScriptSymbol,
  SymbolKind,
} from '@vizscript/core';
import { qualifiedName } from '@vizscript/core';

export const SYMBOL_ICONS: Record<SymbolKind, string> = {
  function: 'i-mdi-function text-sky-400',
  method: 'i-mdi-function text-sky-400',
  class: 'i-mdi-cube-outline text-amber-400',
  variable: 'i-mdi-alpha-x-box-outline text-emerald-400',
  constant: 'i-mdi-alpha-c-box-outline text-emerald-400',
  local: 'i-mdi-alpha-x-box-outline text-zinc-400',
  type: 'i-mdi-shape-outline text-purple-400',
  enum: 'i-mdi-format-list-numbered text-purple-400',
  signal: 'i-mdi-broadcast text-red-400',
  import: 'i-mdi-import text-zinc-400',
};

export const SYMBOL_LABELS: Record<SymbolKind, string> = {
  function: 'Function',
  method: 'Method',
  class: 'Class',
  variable: 'Variable',
  constant: 'Constant',
  local: 'Local variable',
  type: 'Type',
  enum: 'Enum',
  signal: 'Signal',
  import: 'Import',
};

/** "Function", or "Imported function" once the import's file was read. */
export function symbolLabel(symbol: ScriptSymbol): string {
  return symbol.kind === 'import' && symbol.importedKind
    ? `Imported ${SYMBOL_LABELS[symbol.importedKind].toLowerCase()}`
    : SYMBOL_LABELS[symbol.kind];
}

/**
 * Type shown next to a symbol: the declared one, else the inferred pin type
 * (marked as inferred), else `any`.
 */
export function symbolType(symbol: ScriptSymbol): {
  text: string;
  inferred: boolean;
} {
  if (symbol.params) {
    return { text: symbol.returns?.text ?? '', inferred: false };
  }

  if (
    symbol.kind === 'import' &&
    symbol.importedKind !== 'variable' &&
    symbol.importedKind !== 'constant'
  ) {
    return { text: '', inferred: false };
  }

  if (symbol.type) {
    return { text: symbol.type.text, inferred: false };
  }

  return { text: String(symbol.dataType), inferred: true };
}

/** The file's top-level graph (module code, or a GDScript class body). */
export function topLevelGraph(
  doc: GraphDocument | null,
  text: string
): FunctionGraph | undefined {
  return doc?.functions.find(
    (f) => f.range.start === 0 && f.range.end >= text.trimEnd().length
  );
}

const escape = (name: string): string =>
  name.replaceAll(/[$.*+?^()[\]{}|\\]/g, String.raw`\$&`);

/**
 * Nodes that use a symbol, to highlight them like UE highlights the uses of
 * a selected variable: calls of a function, gets and sets of a variable.
 */
export function symbolNodes(
  doc: GraphDocument | null,
  symbol: ScriptSymbol
): string[] {
  if (!doc) {
    return [];
  }

  const name = escape(symbol.name);
  // `name`, `self.name`, `this.name`, `obj.name(…)`; imports: `name`,
  // `name.member` (namespaces, modules, preloaded scripts).
  const uses =
    symbol.kind === 'import'
      ? new RegExp(String.raw`^${name}(?:$|\.)`)
      : new RegExp(String.raw`(?:^|[.\s])${name}$`);
  const sets = new RegExp(String.raw`^Set (?:\w+\.)?${name}$`);
  const graphs =
    symbol.kind === 'local'
      ? doc.functions.filter(
          (f) =>
            f.name === symbol.scope ||
            doc.symbols?.some(
              (s) => s.fnId === f.id && qualifiedName(s) === symbol.scope
            )
        )
      : doc.functions;
  const ids: string[] = [];
  for (const fn of graphs) {
    if (fn.id === symbol.fnId) {
      const entry = fn.nodes.find((n) => n.kind === 'entry');
      if (entry) {
        ids.push(entry.id);
      }
    }

    for (const node of fn.nodes) {
      const matches =
        symbol.kind === 'import'
          ? (node.kind === 'call' ||
              node.kind === 'getVar' ||
              node.kind === 'getProperty') &&
            uses.test(node.title)
          : symbol.kind === 'function' || symbol.kind === 'method'
            ? node.kind === 'call' && uses.test(node.title)
            : (node.kind === 'getVar' || node.kind === 'getProperty') &&
                uses.test(node.title)
              ? true
              : node.kind === 'setVar' && sets.test(node.title);
      if (matches) {
        ids.push(node.id);
      }
    }
  }

  return ids;
}

/** Drag data of a symbol dragged from "My Script" into the graph. */
export const SYMBOL_DRAG_MIME = 'application/x-vizscript-symbol';

/** Symbols that can be dragged into the graph. */
export const DRAGGABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  'function',
  'method',
  'variable',
  'constant',
  'local',
  'signal',
  'import',
]);

/**
 * Where a statement dropped into a function goes: after the last statement
 * of its main flow, or before a final `return` / `throw`.
 */
export function endOfFunction(
  doc: GraphDocument,
  fnId: string
): { after: PinRef } | { before: PinRef } | undefined {
  const fn = doc.functions.find((f) => f.id === fnId);
  if (!fn) {
    return undefined;
  }

  let current = fn.nodes.find((n) => n.kind === 'entry');
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const out =
      current.pins.find(
        (p) =>
          p.kind === 'exec' && p.direction === 'out' && p.id === 'completed'
      ) ??
      current.pins.find(
        (p) => p.kind === 'exec' && p.direction === 'out' && p.id === 'then'
      );
    if (!out) {
      return current.kind === 'entry'
        ? undefined
        : { before: { node: current.id, pin: 'exec' } };
    }

    const node: string = current.id;
    const edge = fn.edges.find(
      (e) => e.kind === 'exec' && e.from.node === node && e.from.pin === out.id
    );
    if (!edge) {
      return { after: { node, pin: out.id } };
    }

    current = fn.nodes.find((n) => n.id === edge.to.node);
  }

  return undefined;
}
