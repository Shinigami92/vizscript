import type { StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type { GraphDocument } from './ir';

const VARIABLE_KINDS = new Set(['variable', 'constant', 'local']);

/**
 * Types known from elsewhere in the graph, after the call pins are complete:
 * - a Return's value takes the function's declared result (`return;` of a
 *   function returning `string` offers string actions);
 * - an untyped variable takes the type of the value it is declared with
 *   (`const t = greet(user)` is a string when `greet` returns one).
 */
export function inferTypes(doc: GraphDocument): void {
  const symbols = doc.symbols ?? [];
  for (const fn of doc.functions) {
    const owner = symbols.find(
      (s) => s.fnId === fn.id && (s.kind === 'function' || s.kind === 'method')
    );
    const result = owner?.returnType;
    if (result === undefined || result === 'any' || result === 'void') {
      continue;
    }

    for (const node of fn.nodes) {
      const pin =
        node.kind === 'return'
          ? node.pins.find((p) => p.id === 'value' && p.type === 'any')
          : undefined;
      if (pin) {
        pin.type = result;
      }
    }
  }

  const declarations = doc.functions.flatMap((f) =>
    f.nodes.filter((n) => n.kind === 'setVar')
  );
  for (const symbol of symbols) {
    if (
      !VARIABLE_KINDS.has(symbol.kind) ||
      symbol.type !== undefined ||
      symbol.dataType !== 'any'
    ) {
      continue;
    }

    const at = symbol.nameRange.start;
    const node = declarations.find((n) => {
      const declares = n.meta?.declares;
      const stmt = getMeta<StatementMeta>(n).stmt ?? n.range;
      return (
        Array.isArray(declares) &&
        declares.length === 1 &&
        declares[0] === symbol.name &&
        stmt.start <= at &&
        at < stmt.end
      );
    });
    const type = node?.pins.find((p) => p.id === 'value')?.type;
    if (type !== undefined && type !== 'any') {
      symbol.dataType = type;
    }
  }
}
