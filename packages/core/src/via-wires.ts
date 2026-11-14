import { edgeId } from './ids';
import type {
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  PinRef,
  Positions,
} from './ir';
import type { TextChange } from './reconcile';
import { renamedNodes } from './reconcile';

/**
 * UE wires a SET node's output straight into other inputs. In code that is
 * a read of the variable, which the graph shows as a Get node; a Get the
 * user wired from a SET is remembered in the layout (`~via|<getId>`, like
 * comment box colors) and drawn as a wire from that SET's output instead.
 * The code is the same either way.
 */
export const VIA_PREFIX = '~via|';

export function viaKey(getId: string): string {
  return `${VIA_PREFIX}${getId}`;
}

export function isViaKey(key: string): boolean {
  return key.startsWith(VIA_PREFIX);
}

/**
 * A Get joined into another Get of the same variable (`~via|<get>|<host>`):
 * wiring from a Get in UE uses that node again, while the code needs a
 * read of its own; it is drawn as a wire from the host's output.
 */
export function joinKey(getId: string, hostId: string): string {
  return `${VIA_PREFIX}${getId}|${hostId}`;
}

/**
 * A Get the user wired from, kept as its node even where the graph would
 * draw it as a wire from its SET (a join to itself).
 */
export function nodeKey(getId: string): string {
  return joinKey(getId, getId);
}

/** The ids of a `~via|` key: the hidden Get and its host Get, if any. */
function parseViaKey(key: string): { get: string; host?: string } {
  const [get = '', host] = key.slice(VIA_PREFIX.length).split('|');
  return host === undefined ? { get } : { get, host };
}

/** The Get node ids drawn as wires from their SET. */
export function viaGets(positions: Positions): Set<string> {
  return new Set(
    Object.keys(positions)
      .filter((key) => isViaKey(key))
      .map(parseViaKey)
      .filter((ids) => ids.host === undefined)
      .map((ids) => ids.get)
  );
}

/** Joined Gets (hidden Get → the Get drawn in its place). */
export function viaJoins(positions: Positions): Map<string, string> {
  const joins = new Map<string, string>();
  for (const key of Object.keys(positions)) {
    const { get, host } = isViaKey(key) ? parseViaKey(key) : { get: '' };
    if (host !== undefined) {
      joins.set(get, host);
    }
  }

  return joins;
}

/** The layout entries of `~via|` keys (kept apart from node positions). */
export function viaEntries(positions: Positions): Positions {
  return Object.fromEntries(
    Object.entries(positions).filter(([key]) => isViaKey(key))
  );
}

/** `~via|` entries follow their Get node when its id changes with an edit. */
export function reconcileVias(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions,
  change?: TextChange
): Positions {
  const entries = viaEntries(positions);
  if (!previous || Object.keys(entries).length === 0) {
    return entries;
  }

  const rename = renamedNodes(previous, next, change);
  const result: Positions = {};
  for (const [key, point] of Object.entries(entries)) {
    const { get, host } = parseViaKey(key);
    const id = rename.get(get) ?? get;
    result[
      host === undefined ? viaKey(id) : joinKey(id, rename.get(host) ?? host)
    ] = point;
  }

  return result;
}

/**
 * The SET a Get reads from: the nearest setter of the same variable before
 * it in the same function, with an output to wire from.
 */
export function viaSetter(
  fn: FunctionGraph,
  get: GraphNode
): GraphNode | undefined {
  if (get.kind !== 'getVar') {
    return undefined;
  }

  const title = `Set ${get.title}`;
  let best: GraphNode | undefined;
  for (const node of fn.nodes) {
    if (
      node.kind === 'setVar' &&
      node.title === title &&
      node.range.end <= get.range.start &&
      node.pins.some((p) => p.id === 'out') &&
      (!best || node.range.start > best.range.start)
    ) {
      best = node;
    }
  }

  return best;
}

/**
 * A node and the pure nodes feeding it (`.ok` and `!` of `if
 * (!response.ok)`): pure nodes are computed when the node runs.
 */
function withPureInputs(
  fn: FunctionGraph,
  ids: ReadonlySet<string>
): Set<string> {
  const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
  const result = new Set(ids);
  const queue = [...ids];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const edge of fn.edges) {
      const source = nodes.get(edge.from.node);
      if (
        edge.kind === 'data' &&
        edge.to.node === id &&
        source?.purity === 'pure' &&
        !result.has(source.id)
      ) {
        result.add(source.id);
        queue.push(source.id);
      }
    }
  }

  return result;
}

function isLoop(n: GraphNode | undefined): boolean {
  return n?.kind === 'forEach' || n?.kind === 'loop';
}

/**
 * The exec nodes that run right after a node: those its exec outputs lead
 * to, or, for a SET that ends a loop body (nothing runs after it in the
 * body, and it is the body's only SET of its variable), those after the
 * loop (UE: that SET wired to the node after Completed).
 */
function nextAfter(fn: FunctionGraph, id: string): Set<string> {
  const execs = fn.edges.filter((e) => e.kind === 'exec');
  const out = (node: string, pin?: string): string[] =>
    execs
      .filter((e) => e.from.node === node && (!pin || e.from.pin === pin))
      .map((e) => e.to.node);
  const own = out(id);
  const node = fn.nodes.find((n) => n.id === id);
  if (own.length > 0 || !node) {
    return new Set(own);
  }

  const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
  for (const loop of fn.nodes) {
    if (!isLoop(loop)) {
      continue;
    }

    // The loop's own body: nested loops' bodies are theirs.
    const body = new Set<string>();
    const queue = out(loop.id, 'body');
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (body.has(next)) {
        continue;
      }

      body.add(next);
      queue.push(
        ...execs
          .filter(
            (e) =>
              e.from.node === next &&
              !(isLoop(nodes.get(next)) && e.from.pin === 'body')
          )
          .map((e) => e.to.node)
      );
    }

    const setters = [...body].filter((b) => {
      const n = nodes.get(b);
      return n?.kind === 'setVar' && n.title === node.title;
    });
    if (body.has(id)) {
      return setters.length === 1
        ? new Set(out(loop.id, 'completed'))
        : new Set();
    }
  }

  return new Set();
}

/**
 * Gets drawn as wires without being remembered: those that feed the node
 * right after their variable's SET on the exec chain (`const cart = …;`
 * then `totalPrice(cart)`, also through pure nodes: `if (!response.ok)`),
 * as one would wire it in UE. Reads further away stay Get nodes; the
 * variable could have changed by then.
 */
export function adjacentVias(doc: GraphDocument): Set<string> {
  const result = new Set<string>();
  for (const fn of doc.functions) {
    const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
    for (const setter of fn.nodes) {
      if (
        setter.kind !== 'setVar' ||
        !setter.title.startsWith('Set ') ||
        !setter.pins.some((p) => p.id === 'out')
      ) {
        continue;
      }

      const variable = setter.title.slice('Set '.length);
      const next = withPureInputs(fn, nextAfter(fn, setter.id));
      for (const edge of fn.edges) {
        const get = nodes.get(edge.from.node);
        if (
          edge.kind === 'data' &&
          next.has(edge.to.node) &&
          get?.kind === 'getVar' &&
          get.title === variable &&
          viaSetter(fn, get) === setter
        ) {
          result.add(get.id);
        }
      }
    }
  }

  return result;
}

/**
 * The graph as drawn: remembered Gets and those right after their SET
 * (`adjacentVias`) become wires from the SET's output (`GraphEdge.via`
 * names the hidden Get). Gets without a SET before them stay nodes.
 */
export function foldVias(
  doc: GraphDocument,
  remembered: ReadonlySet<string>,
  joins: ReadonlyMap<string, string> = new Map()
): GraphDocument {
  const gets = new Set([...remembered, ...adjacentVias(doc)]);
  if (gets.size === 0 && joins.size === 0) {
    return doc;
  }

  let changed = false;
  const functions = doc.functions.map((fn) => {
    // Hidden Get → the output its wires are drawn from.
    const hidden = new Map<string, PinRef>();
    for (const node of fn.nodes) {
      // A Get the user wired (joined, or kept as its node) stays so.
      const setter =
        gets.has(node.id) && !joins.has(node.id)
          ? viaSetter(fn, node)
          : undefined;
      if (setter) {
        hidden.set(node.id, { node: setter.id, pin: 'out' });
      }
    }

    const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
    for (const [id, hostId] of joins) {
      if (id === hostId) {
        continue;
      }

      const get = nodes.get(id);
      const host = nodes.get(hostId);
      const out = host?.pins.find((p) => p.direction === 'out');
      if (
        get?.kind === 'getVar' &&
        host?.kind === 'getVar' &&
        host.title === get.title &&
        out &&
        !hidden.has(id) &&
        (joins.get(hostId) ?? hostId) === hostId
      ) {
        // A host drawn from its SET draws the joined wires from there too.
        hidden.set(id, hidden.get(hostId) ?? { node: hostId, pin: out.id });
      }
    }

    if (hidden.size === 0) {
      return fn;
    }

    changed = true;
    const edges: GraphEdge[] = fn.edges.map((edge) => {
      const from = hidden.get(edge.from.node);
      if (!from) {
        return edge;
      }

      return { ...edge, id: edgeId(from, edge.to), from, via: edge.from.node };
    });
    return {
      ...fn,
      nodes: fn.nodes.filter((n) => !hidden.has(n.id)),
      edges: edges.filter((e) => !hidden.has(e.to.node)),
    };
  });
  return changed ? { ...doc, functions } : doc;
}
