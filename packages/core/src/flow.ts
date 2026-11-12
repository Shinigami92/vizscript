import type { GraphDocument, PinRef } from './ir';

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
