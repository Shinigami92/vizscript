import type { FunctionGraph, GraphNode, Pin } from './ir';

/** Nodes whose untyped inputs take any value, like UE's wildcard pins. */
const WILDCARD_NODES = new Set(['operator', 'select', 'ternary']);

function isWildcard(node: GraphNode, pin: Pin): boolean {
  return (
    WILDCARD_NODES.has(node.kind) &&
    pin.direction === 'in' &&
    pin.kind === 'data' &&
    pin.type === 'any'
  );
}

/**
 * The function with the untyped inputs of operators (`a * b`, `x as f64`,
 * `c ? a : b`) typed like the outputs wired into them, as UE's wildcard
 * pins take the type of their connection. Unchanged parts are shared.
 */
export function typeWildcardPins(fn: FunctionGraph): FunctionGraph {
  const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
  const typed = new Map<string, Map<string, Pin['type']>>();
  for (const edge of fn.edges) {
    const target = nodes.get(edge.to.node);
    const pin = target?.pins.find((p) => p.id === edge.to.pin);
    if (!target || !pin || !isWildcard(target, pin)) {
      continue;
    }

    const source = nodes
      .get(edge.from.node)
      ?.pins.find((p) => p.id === edge.from.pin);
    if (source && source.type !== 'any' && source.type !== 'void') {
      const pins = typed.get(target.id) ?? new Map<string, Pin['type']>();
      pins.set(pin.id, source.type);
      typed.set(target.id, pins);
    }
  }

  if (typed.size === 0) {
    return fn;
  }

  return {
    ...fn,
    nodes: fn.nodes.map((node) => {
      const pins = typed.get(node.id);
      return pins
        ? {
            ...node,
            pins: node.pins.map((p) => {
              const type = pins.get(p.id);
              return type === undefined ? p : { ...p, type };
            }),
          }
        : node;
    }),
  };
}
