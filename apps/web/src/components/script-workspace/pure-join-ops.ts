import type {
  FunctionGraph,
  GraphDocument,
  GraphOp,
  PinRef,
} from '@vizscript/core';
import { copyTree, findNode, joinedNode } from '@vizscript/core';

/** A pure copy drawn as its host (`foldVias`): one node in the graph. */
export interface PureJoin {
  fn: FunctionGraph;
  host: string;
  copy: string;
}

/**
 * The pure copies the graph draws as their host: the `via` of a wire
 * drawn from a node that isn't a Get (Gets join their own way).
 */
export function pureJoins(
  shown: GraphDocument,
  drawn: GraphDocument
): PureJoin[] {
  const joins: PureJoin[] = [];
  for (const fn of shown.functions) {
    const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
    const seen = new Set<string>();
    for (const edge of drawn.functions.flatMap((f) => f.edges)) {
      const copy = edge.via ? nodes.get(edge.via) : undefined;
      const host = nodes.get(edge.from.node);
      if (
        copy &&
        host &&
        copy.kind !== 'getVar' &&
        copy.purity === 'pure' &&
        !seen.has(copy.id)
      ) {
        seen.add(copy.id);
        joins.push({ fn, host: host.id, copy: copy.id });
      }
    }
  }

  return joins;
}

/** Whether a node is a pure copy drawn as its host (not a Get). */
export function isPureCopy(shown: GraphDocument | null, id: string): boolean {
  const node = shown ? findNode(shown, id) : undefined;
  return node?.purity === 'pure' && node.kind !== 'getVar';
}

/** Copies with all their parts: deleted along with their host. */
export function withCopyParts(
  joins: ReadonlyArray<PureJoin>,
  copies: ReadonlyArray<string>
): string[] {
  return copies.flatMap((id) => {
    const join = joins.find((j) => j.copy === id);
    return join ? [...copyTree(join.fn, id)] : [id];
  });
}

/** The nodes of copies standing where `node` stands in their host. */
function copiesOf(joins: ReadonlyArray<PureJoin>, node: string): string[] {
  return joins.flatMap(({ fn, host, copy }) => {
    const at = joinedNode(fn, host, copy, node);
    return at && at !== node ? [at] : [];
  });
}

/**
 * An edit of a joined node is written at each of its copies too, in one
 * edit (UE: it is one node): literals, member, format, pins, and wires
 * into its inputs.
 */
export function fanOut(op: GraphOp, joins: ReadonlyArray<PureJoin>): GraphOp {
  if (joins.length === 0) {
    return op;
  }

  const atPin = (pin: PinRef): PinRef[] =>
    copiesOf(joins, pin.node).map((node) => ({ node, pin: pin.pin }));
  let more: GraphOp[] = [];
  switch (op.type) {
    case 'setLiteral':
    case 'replaceReference':
    case 'setFormat':
    case 'addArgument': {
      more = copiesOf(joins, op.node).map((node) => ({ ...op, node }));
      break;
    }

    case 'removeArgument':
    case 'disconnect': {
      more = atPin(op.pin).map((pin) => ({ ...op, pin }));
      break;
    }

    case 'connect': {
      more = atPin(op.to).map((to) => ({ ...op, to }));
      break;
    }

    default: {
      break;
    }
  }

  return more.length > 0 ? { type: 'all', ops: [op, ...more] } : op;
}
