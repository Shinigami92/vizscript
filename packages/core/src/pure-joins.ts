import { owningStatement } from './edit-meta';
import type { FunctionGraph, GraphDocument, GraphNode, PinRef } from './ir';

/**
 * UE wires one pure node (`.quantity`, `a + b`) into several inputs and
 * computes it again for each. The code writes the expression at each use;
 * those copies are drawn as one node, the first, with a wire to each use
 * (a join, like `joinKey` of Gets). Copies must be the same expression:
 * `pureSignature` compares them.
 */

/** The data wires into each node of a function, by node and pin. */
function inputsOf(fn: FunctionGraph): Map<string, Map<string, PinRef>> {
  const inputs = new Map<string, Map<string, PinRef>>();
  for (const edge of fn.edges) {
    if (edge.kind !== 'data') {
      continue;
    }

    const pins = inputs.get(edge.to.node) ?? new Map<string, PinRef>();
    pins.set(edge.to.pin, edge.from);
    inputs.set(edge.to.node, pins);
  }

  return inputs;
}

/**
 * A key equal for two pure nodes that compute the same expression: kind,
 * title and, per input, its literal, the signature of the pure node wired
 * into it, or the output of anything else wired into it (the same loop
 * item, parameter or call result). `undefined` for nodes that aren't pure.
 */
export function pureSignature(
  fn: FunctionGraph,
  nodeId: string,
  memo: Map<string, string | undefined> = new Map(),
  inputs: Map<string, Map<string, PinRef>> = inputsOf(fn)
): string | undefined {
  if (memo.has(nodeId)) {
    return memo.get(nodeId);
  }

  // A cycle can't be pure; this also guards against one.
  memo.set(nodeId, undefined);
  const node = fn.nodes.find((n) => n.id === nodeId);
  if (!node || node.purity !== 'pure') {
    return undefined;
  }

  const wired = inputs.get(node.id);
  const parts = [`${node.kind}|${node.title}|${node.subtitle ?? ''}`];
  for (const pin of node.pins) {
    if (pin.kind !== 'data' || pin.direction !== 'in') {
      continue;
    }

    const from = wired?.get(pin.id);
    if (!from) {
      parts.push(`${pin.id}=${pin.literal?.value ?? ''}`);
      continue;
    }

    const source = pureSignature(fn, from.node, memo, inputs);
    parts.push(
      source === undefined
        ? `${pin.id}@${from.node}:${from.pin}`
        : `${pin.id}(${source}).${from.pin}`
    );
  }

  const signature = parts.join(';');
  memo.set(nodeId, signature);
  return signature;
}

/**
 * A copy and the pure nodes that feed only it (and each other): hidden
 * together when the copy is drawn as its host. Nodes that also feed
 * something else (a Get shared with another use) stay.
 */
export function copyTree(fn: FunctionGraph, root: string): Set<string> {
  const tree = new Set([root]);
  const pure = new Set(
    fn.nodes.filter((n) => n.purity === 'pure').map((n) => n.id)
  );
  const data = fn.edges.filter((e) => e.kind === 'data');
  for (let grown = true; grown;) {
    grown = false;
    for (const edge of data) {
      const source = edge.from.node;
      if (
        tree.has(edge.to.node) &&
        !tree.has(source) &&
        pure.has(source) &&
        data
          .filter((e) => e.from.node === source)
          .every((e) => tree.has(e.to.node))
      ) {
        tree.add(source);
        grown = true;
      }
    }
  }

  return tree;
}

/** Length of a node's code (larger expressions are joined first). */
function size(node: GraphNode): number {
  return node.range.end - node.range.start;
}

/**
 * Identical pure expressions within one statement (`x * x`,
 * `item.price * item.quantity + item.quantity`): nothing runs between
 * them, so one node, the first in the code, feeds all their uses. Each
 * copy maps to that node, like `wrappedVias`. Only the outermost copies
 * join: the parts inside a joined copy go with it.
 */
export function statementJoins(doc: GraphDocument): Map<string, string> {
  const result = new Map<string, string>();
  for (const fn of doc.functions) {
    const memo = new Map<string, string | undefined>();
    const inputs = inputsOf(fn);
    const groups = new Map<string, GraphNode[]>();
    for (const node of fn.nodes) {
      const stmt = node.purity === 'pure' ? owningStatement(node) : undefined;
      const signature = stmt
        ? pureSignature(fn, node.id, memo, inputs)
        : undefined;
      if (stmt && signature !== undefined) {
        const key = `${stmt.stmt.start}:${stmt.stmt.end}|${signature}`;
        groups.set(key, [...(groups.get(key) ?? []), node]);
      }
    }

    const covered = new Set<string>();
    const ordered = [...groups.values()]
      .filter((g) => g.length > 1)
      .toSorted((a, b) => size(b[0] as GraphNode) - size(a[0] as GraphNode));
    for (const group of ordered) {
      const [host, ...copies] = group
        .filter((n) => !covered.has(n.id))
        .toSorted((a, b) => a.range.start - b.range.start);
      if (!host) {
        continue;
      }

      for (const copy of copies) {
        result.set(copy.id, host.id);
        for (const id of copyTree(fn, copy.id)) {
          covered.add(id);
        }
      }

      // The host's own parts stay its nodes, not joins of their own.
      for (const id of copies.length > 0 ? copyTree(fn, host.id) : []) {
        covered.add(id);
      }
    }
  }

  return result;
}

/** The input pins from `from` down to `target`, through pure nodes. */
function pathTo(
  fn: FunctionGraph,
  inputs: Map<string, Map<string, PinRef>>,
  from: string,
  target: string,
  seen: Set<string>
): string[] | undefined {
  if (from === target) {
    return [];
  }

  if (seen.has(from)) {
    return undefined;
  }

  seen.add(from);
  for (const [pin, source] of inputs.get(from) ?? []) {
    const node = fn.nodes.find((n) => n.id === source.node);
    const rest =
      node?.purity === 'pure'
        ? pathTo(fn, inputs, source.node, target, seen)
        : undefined;
    if (rest) {
      return [pin, ...rest];
    }
  }

  return undefined;
}

/**
 * The node of a joined copy that stands where `target` stands in its host
 * (the host itself, or a pure node feeding it): an edit of the host's
 * node is written at the copy's too. `undefined` when `target` isn't part
 * of the host.
 */
export function joinedNode(
  fn: FunctionGraph,
  host: string,
  copy: string,
  target: string
): string | undefined {
  const inputs = inputsOf(fn);
  const path = pathTo(fn, inputs, host, target, new Set());
  let at: string | undefined = path ? copy : undefined;
  for (const pin of path ?? []) {
    at = at === undefined ? undefined : inputs.get(at)?.get(pin)?.node;
  }

  return at;
}
