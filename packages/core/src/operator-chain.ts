import type { GraphNode, Pin } from './ir';

/**
 * Binary operators whose chains (`a + b + c`) are one node with a pin per
 * value, like UE's math nodes with "Add pin +". Left-associative, so the
 * chain reads left to right; comparisons, `**` and shifts are left out.
 */
export const CHAIN_OPERATORS: ReadonlySet<string> = new Set([
  '+',
  '-',
  '*',
  '/',
  '//',
  '%',
  '&',
  '|',
  '^',
  '&&',
  '||',
  '??',
  'and',
  'or',
]);

/** UE names the pins of a math node by letter, so up to 26 of them. */
export const MAX_CHAIN_PINS = 26;

/** The id of the chain's value at `index`: `a`, `b`, `c` … */
export function chainPinId(index: number): string {
  return String.fromCodePoint(97 + index);
}

/**
 * The values of an operator chain, left to right: `split` gives the two
 * sides of an expression of the chain's operator (or `undefined`). The
 * left side continues the chain while it starts where the chain does, so
 * a parenthesized `(a + b) + c` stays two nodes.
 */
export function flattenChain<T>(
  root: T,
  split: (expr: T) => [left: T, right: T] | undefined,
  start: (expr: T) => number
): T[] {
  const rights: T[] = [];
  let current = root;
  for (;;) {
    const sides = split(current);
    if (
      !sides ||
      (current !== root && start(current) !== start(root)) ||
      rights.length + 2 > MAX_CHAIN_PINS
    ) {
      return [current, ...rights];
    }

    rights.unshift(sides[1]);
    current = sides[0];
  }
}

function chainInputs(node: GraphNode): Pin[] {
  return node.pins.filter((p) => p.direction === 'in' && p.kind === 'data');
}

/** An operator node of a chain (`a + b`, `a + b + c`): its values. */
export function chainValues(node: GraphNode): Pin[] | undefined {
  if (node.kind !== 'operator' || !CHAIN_OPERATORS.has(node.title)) {
    return undefined;
  }

  const inputs = chainInputs(node);
  return inputs.length >= 2 &&
    inputs.every((p, i) => p.id === chainPinId(i) && p.range !== undefined)
    ? inputs
    : undefined;
}

/** Literals that grow like UE's Make Array (not tuples, sets or `[x; n]`). */
const GROWING_ARRAYS: ReadonlySet<string> = new Set([
  'Make Array',
  'Make List',
  'Make Vec',
]);

/** A Make Array node of a literal (`[a, b]`): its elements. */
export function arrayElements(node: GraphNode): Pin[] | undefined {
  if (
    node.kind !== 'makeArray' ||
    !GROWING_ARRAYS.has(node.title) ||
    node.subtitle !== undefined
  ) {
    return undefined;
  }

  const inputs = chainInputs(node);
  return inputs.every((p) => /^e\d+$/.test(p.id) && p.range !== undefined)
    ? inputs
    : undefined;
}

/** Object and dictionary literals (not structs: their fields are fixed). */
const GROWING_OBJECTS: ReadonlySet<string> = new Set([
  'Make Object',
  'Make Dict',
  'Make Dictionary',
]);

/** A Make Object node of a literal (`{ a: 1 }`): its entries. */
export function objectEntries(node: GraphNode): Pin[] | undefined {
  return node.kind === 'makeObject' && GROWING_OBJECTS.has(node.title)
    ? chainInputs(node)
    : undefined;
}

/**
 * UE's "Add pin +": a call with a rest parameter, an operator chain, a
 * Make Array or a Make Object.
 */
export function canAddPin(node: GraphNode): boolean {
  if (
    node.addPin === true ||
    arrayElements(node) !== undefined ||
    objectEntries(node) !== undefined
  ) {
    return true;
  }

  const values = chainValues(node);
  return values !== undefined && values.length < MAX_CHAIN_PINS;
}
