import type {
  FunctionGraph,
  GraphDocument,
  ScriptSymbol,
  SymbolKind,
} from '@vizscript/core';
import { callsOwnFunction, qualifiedName } from '@vizscript/core';

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
  if (symbol.modifiers.includes('callback')) {
    return 'Callback';
  }

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
  // A function spanning the whole file is still a function: it has a symbol.
  return doc?.functions.find(
    (f) =>
      f.range.start === 0 &&
      f.range.end >= text.trimEnd().length &&
      !doc.symbols?.some((s) => s.fnId === f.id)
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
      // A call on a value (`console.log`) is a method of that value, not
      // the file's function or import of that name.
      const ownCall =
        node.kind === 'call' &&
        node.title === symbol.name &&
        (symbol.kind === 'method' || callsOwnFunction(fn, node));
      const matches =
        symbol.kind === 'import'
          ? ((node.kind === 'getVar' || node.kind === 'getProperty') &&
              uses.test(node.title)) ||
            ownCall
          : symbol.kind === 'function' || symbol.kind === 'method'
            ? ownCall
            : ((node.kind === 'getVar' || node.kind === 'getProperty') &&
                uses.test(node.title)) ||
              (node.kind === 'setVar' && sets.test(node.title));
      if (matches) {
        ids.push(node.id);
      }
    }
  }

  return ids;
}

/**
 * Wires from a function's input (its entry pin) into the body: the uses that
 * stay behind when the input is removed.
 */
export function parameterUses(
  doc: GraphDocument | null | undefined,
  fn: ScriptSymbol,
  name: string
): number {
  const graph = doc?.functions.find((f) => f.id === fn.fnId);
  const entry = graph?.nodes.find((n) => n.kind === 'entry');
  const pin = entry?.pins.find(
    (p) =>
      p.kind === 'data' &&
      p.direction === 'out' &&
      p.name.replace(/^\*+/, '') === name
  );
  if (!graph || !entry || !pin) {
    return 0;
  }

  return graph.edges.filter(
    (e) => e.from.node === entry.id && e.from.pin === pin.id
  ).length;
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
