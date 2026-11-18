import { isElementGet } from './element-access';
import type { DataType, FunctionGraph, GraphNode, Pin } from './ir';

/**
 * Nodes whose untyped inputs take any value, like UE's wildcard pins:
 * operators, selects and the values of a Format Text (`{0}`, `{1}`).
 */
const WILDCARD_NODES = new Set(['operator', 'select', 'ternary', 'template']);

function isWildcard(node: GraphNode, pin: Pin): boolean {
  return (
    (WILDCARD_NODES.has(node.kind) || isElementGet(node)) &&
    pin.direction === 'in' &&
    pin.kind === 'data' &&
    pin.type === 'any'
  );
}

/**
 * The function with the untyped inputs of operators (`a * b`, `x as f64`,
 * `c ? a : b`), Format Texts (`f"{error}"`) and element reads (`items[0]`)
 * typed like the outputs wired into them, as UE's wildcard
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

/** Input types that take any value. */
const OPEN_TYPES = new Set<DataType>(['any', 'void', 'object']);

/**
 * Nodes whose results come from code the graph can't see into: calls,
 * awaits and members. Gets of variables keep the variable's type (`None`
 * fed into a number is no number), operators type themselves.
 */
const COMPUTED = new Set<string>(['call', 'await', 'getProperty']);

/**
 * The function with untyped outputs (`json.load(…)` is `Any`,
 * `JSON.parse(…)` too) typed like the inputs they are wired into when
 * those agree (`return json.load(f)` in a function returning `dict`), as
 * UE's wildcard pins take the type of a connection in either direction.
 * They are marked `usedAs`: the code doesn't say so. Only results of
 * calls, awaits and members; inputs that take anything don't count; uses
 * that disagree leave the output untyped.
 */
export function typeOutputsByUse(fn: FunctionGraph): FunctionGraph {
  const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
  const uses = new Map<string, Set<DataType>>();
  for (const edge of fn.edges) {
    if (edge.kind !== 'data') {
      continue;
    }

    const type = nodes
      .get(edge.to.node)
      ?.pins.find((p) => p.id === edge.to.pin)?.type;
    const key = `${edge.from.node}\u0000${edge.from.pin}`;
    const types = uses.get(key) ?? new Set<DataType>();
    // Inputs that take anything say nothing (a call's Target is `object`).
    if (type !== undefined && !OPEN_TYPES.has(type)) {
      types.add(type);
    }

    uses.set(key, types);
  }

  let changed = false;
  const typed = fn.nodes.map((node) => {
    if (!COMPUTED.has(node.kind)) {
      return node;
    }

    let pinsChanged = false;
    const pins = node.pins.map((pin) => {
      if (
        pin.direction !== 'out' ||
        pin.kind !== 'data' ||
        (pin.type !== 'any' && pin.usedAs !== true)
      ) {
        return pin;
      }

      const types = uses.get(`${node.id}\u0000${pin.id}`);
      const [only] = types ?? [];
      const next: Pin =
        types?.size === 1 && only !== undefined
          ? { ...pin, type: only, usedAs: true }
          : { ...pin, type: 'any', usedAs: undefined };
      if (next.type === pin.type && next.usedAs === pin.usedAs) {
        return pin;
      }

      pinsChanged = true;
      if (next.usedAs === undefined) {
        delete next.usedAs;
      }

      return next;
    });
    changed ||= pinsChanged;
    return pinsChanged ? { ...node, pins } : node;
  });
  return changed ? { ...fn, nodes: typed } : fn;
}
