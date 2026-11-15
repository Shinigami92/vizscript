import { edgeId } from './ids';
import type {
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  PinRef,
  Positions,
} from './ir';
import { copyTree, pureSignature, statementJoins } from './pure-joins';
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

/** A Get right after its variable's SET (see `adjacentVias`). */
interface AdjacentRead {
  setter: GraphNode;
  get: GraphNode;
}

function adjacentReads(doc: GraphDocument): AdjacentRead[] {
  const result: AdjacentRead[] = [];
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
      const seen = new Set<string>();
      for (const edge of fn.edges) {
        const get = nodes.get(edge.from.node);
        if (
          edge.kind === 'data' &&
          next.has(edge.to.node) &&
          get?.kind === 'getVar' &&
          get.title === variable &&
          !seen.has(get.id) &&
          viaSetter(fn, get) === setter
        ) {
          seen.add(get.id);
          result.push({ setter, get });
        }
      }
    }
  }

  return result;
}

/**
 * The generated layout put the SET right of the read: the exec chain
 * wrapped to a new row in between, and a wire would run back across it.
 */
function wraps(read: AdjacentRead, layout: Positions | undefined): boolean {
  const setter = layout?.[read.setter.id];
  const get = layout?.[read.get.id];
  return setter !== undefined && get !== undefined && get.x < setter.x;
}

/**
 * Gets drawn as wires without being remembered: those that feed the node
 * right after their variable's SET on the exec chain (`const cart = …;`
 * then `totalPrice(cart)`, also through pure nodes: `if (!response.ok)`),
 * as one would wire it in UE. Reads further away stay Get nodes; the
 * variable could have changed by then. With the generated `layout`, reads
 * on a wrapped row stay nodes too (`wrappedVias`).
 */
export function adjacentVias(
  doc: GraphDocument,
  layout?: Positions
): Set<string> {
  return new Set(
    adjacentReads(doc)
      .filter((read) => !wraps(read, layout))
      .map((read) => read.get.id)
  );
}

/**
 * Reads right after their SET that the generated layout wrapped to a new
 * row (`total += …` ending a loop body, then `total - total * discount`
 * after it): like one would wire it in UE, one Get node left of them
 * feeds them all, instead of wires running back from the SET. Each read
 * maps to that Get (the leftmost one, which maps to itself), like
 * `viaJoins`.
 */
export function wrappedVias(
  doc: GraphDocument,
  layout: Positions
): Map<string, string> {
  const hosts = new Map<string, GraphNode>();
  const result = new Map<string, string>();
  // The leftmost read is the shared Get: its wires all run forward.
  const x = (node: GraphNode): number => layout[node.id]?.x ?? 0;
  const wrapped = adjacentReads(doc)
    .filter((read) => wraps(read, layout))
    .toSorted(
      (a, b) => x(a.get) - x(b.get) || a.get.range.start - b.get.range.start
    );
  for (const { setter, get } of wrapped) {
    const host = hosts.get(setter.id) ?? get;
    hosts.set(setter.id, host);
    result.set(get.id, host.id);
  }

  return result;
}

/**
 * `~via|` entries keeping reads that shared one Get before an edit
 * (`before`, from `wrappedVias`) on that Get, where the generated layout
 * of the edited graph no longer wraps them or picks another of them: the
 * nodes stay where they were drawn, so wires from the SET would run back
 * across the row, or another Get would show up where none was.
 */
export function keptWrapped(
  before: ReadonlyMap<string, string>,
  next: GraphDocument,
  rename: ReadonlyMap<string, string>,
  layout: Positions
): Positions {
  const ids = new Set(next.functions.flatMap((f) => f.nodes).map((n) => n.id));
  // The shared Get → its reads still there, leftmost first.
  const groups = new Map<string, string[]>();
  for (const [get, host] of before) {
    const id = rename.get(get) ?? get;
    if (ids.has(id)) {
      groups.set(host, [...(groups.get(host) ?? []), id]);
    }
  }

  const adjacent = adjacentVias(next, layout);
  const wrapped = wrappedVias(next, layout);
  const patch: Positions = {};
  for (const [host, reads] of groups) {
    const [first] = reads;
    const kept = rename.get(host) ?? host;
    const shared = reads.includes(kept) ? kept : first;
    // Still drawn as that Get by the new layout: nothing to keep.
    if (
      shared === undefined ||
      reads.every((id) => !adjacent.has(id) && wrapped.get(id) === shared)
    ) {
      continue;
    }

    for (const id of reads) {
      patch[id === shared ? nodeKey(id) : joinKey(id, shared)] = {
        x: 0,
        y: 0,
      };
    }
  }

  return patch;
}

/**
 * The graph as drawn: remembered Gets and those right after their SET
 * (`adjacentVias`) become wires from the SET's output (`GraphEdge.via`
 * names the hidden Get). Gets without a SET before them stay nodes. With
 * the generated `layout`, reads it wrapped to a new row share one Get
 * (`wrappedVias`).
 */
export function foldVias(
  doc: GraphDocument,
  remembered: ReadonlySet<string>,
  userJoins: ReadonlyMap<string, string> = new Map(),
  layout?: Positions
): GraphDocument {
  const gets = new Set([...remembered, ...adjacentVias(doc, layout)]);
  // Wrapped reads share one Get; what the user wired or kept wins.
  const joins = new Map(userJoins);
  for (const [id, host] of layout ? wrappedVias(doc, layout) : []) {
    if (!remembered.has(id) && !joins.has(id)) {
      joins.set(id, host);
    }
  }

  // Identical pure expressions of one statement share one node too.
  const hosts = new Set(joins.values());
  for (const [id, host] of statementJoins(doc, layout)) {
    if (!remembered.has(id) && !joins.has(id) && !hosts.has(id)) {
      joins.set(id, host);
    }
  }

  if (gets.size === 0 && joins.size === 0) {
    return doc;
  }

  let changed = false;
  const functions = doc.functions.map((fn) => {
    // Hidden node → the output its wires are drawn from (`pin` empty: the
    // same pin of a joined copy's host).
    const hidden = new Map<string, PinRef>();
    // The parts of hidden copies: drawn as the host's parts.
    const dropped = new Set<string>();
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
    const memo = new Map<string, string | undefined>();
    for (const [id, hostId] of joins) {
      const copy = nodes.get(id);
      const host = nodes.get(hostId);
      if (
        id === hostId ||
        !copy ||
        !host ||
        hidden.has(id) ||
        dropped.has(id) ||
        dropped.has(hostId) ||
        (joins.get(hostId) ?? hostId) !== hostId
      ) {
        continue;
      }

      const out = host.pins.find((p) => p.direction === 'out');
      if (
        copy.kind === 'getVar' &&
        host.kind === 'getVar' &&
        host.title === copy.title &&
        out
      ) {
        // A host drawn from its SET draws the joined wires from there too.
        hidden.set(id, hidden.get(hostId) ?? { node: hostId, pin: out.id });
        continue;
      }

      const signature = pureSignature(fn, id, memo);
      if (
        copy.kind !== 'getVar' &&
        signature !== undefined &&
        signature === pureSignature(fn, hostId, memo)
      ) {
        hidden.set(id, { node: hostId, pin: '' });
        for (const part of copyTree(fn, id)) {
          if (part !== id) {
            dropped.add(part);
          }
        }
      }
    }

    // A join whose host went with a hidden copy stays its own node.
    for (const [id, via] of hidden) {
      if (dropped.has(via.node)) {
        hidden.delete(id);
      }
    }

    if (hidden.size === 0) {
      return fn;
    }

    changed = true;
    const gone = (node: string): boolean =>
      hidden.has(node) || dropped.has(node);
    const edges: GraphEdge[] = fn.edges.flatMap((edge) => {
      if (gone(edge.to.node) || dropped.has(edge.from.node)) {
        return [];
      }

      const via = hidden.get(edge.from.node);
      if (!via) {
        return [edge];
      }

      const from = via.pin ? via : { node: via.node, pin: edge.from.pin };
      return [
        { ...edge, id: edgeId(from, edge.to), from, via: edge.from.node },
      ];
    });
    return {
      ...fn,
      nodes: fn.nodes.filter((n) => !gone(n.id)),
      edges,
    };
  });
  return changed ? { ...doc, functions } : doc;
}
