import type { StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type { GraphDocument, GraphNode } from './ir';
import type { ScriptSymbol } from './symbols';
import { typeWildcardPins } from './wildcard-pins';

const VARIABLE_KINDS = new Set(['variable', 'constant', 'local']);

/**
 * The SET node that declares a variable with its value (`const x = …`):
 * where the graph computes it.
 */
export function declaringNode(
  doc: GraphDocument,
  symbol: ScriptSymbol
): GraphNode | undefined {
  const at = symbol.nameRange.start;
  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      const declares = node.meta?.declares;
      const stmt = getMeta<StatementMeta>(node).stmt ?? node.range;
      if (
        node.kind === 'setVar' &&
        Array.isArray(declares) &&
        declares.length === 1 &&
        declares[0] === symbol.name &&
        stmt.start <= at &&
        at < stmt.end
      ) {
        return node;
      }
    }
  }

  return undefined;
}

/**
 * Types known from elsewhere in the graph, after the call pins are complete:
 * - a Return's value takes the function's declared result (`return;` of a
 *   function returning `string` offers string actions);
 * - an untyped variable takes the type of the value it is declared with
 *   (`const t = greet(user)` is a string when `greet` returns one);
 * - untyped inputs of operators take the type wired into them.
 */
export function inferTypes(doc: GraphDocument): void {
  const symbols = doc.symbols ?? [];
  for (const fn of doc.functions) {
    const owner = symbols.find(
      (s) => s.fnId === fn.id && (s.kind === 'function' || s.kind === 'method')
    );
    const result = owner?.returnType;
    // An async function returns the promised value, not the `Promise`.
    const promised =
      owner?.modifiers.includes('async') === true &&
      /^Promise\s*</.test(owner.returns?.text ?? '');
    if (
      result === undefined ||
      result === 'any' ||
      result === 'void' ||
      promised
    ) {
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

  for (const symbol of symbols) {
    if (
      !VARIABLE_KINDS.has(symbol.kind) ||
      symbol.type !== undefined ||
      symbol.dataType !== 'any'
    ) {
      continue;
    }

    const node = declaringNode(doc, symbol);
    const type = node?.pins.find((p) => p.id === 'value')?.type;
    if (type !== undefined && type !== 'any' && type !== 'void') {
      symbol.dataType = type;
    }
  }

  doc.functions = doc.functions.map(typeWildcardPins);
}
