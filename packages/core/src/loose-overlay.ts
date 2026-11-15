import type { FloatingNodes, GraphEdit, GraphOverlay } from './graph-overlay';
import { floatingGroup } from './graph-overlay';
import type { Positions } from './ir';

/**
 * Graph-only nodes not part of the program (UE: nodes nobody wired into
 * the flow): floating groups whose exec pins and data outputs reach no
 * node of the code. They don't hold the code back (no "not in sync") and
 * stay in the graph until they are wired in or deleted. Data wires from
 * the code into them are part of them (`item.price * item.quantity` still
 * reads the loop's item).
 */
export interface SplitOverlay {
  /** Loose floating groups and the graph-only wires of them. */
  loose: GraphOverlay;
  /** The rest: edits the code has to follow. */
  active: GraphOverlay;
}

export function splitLoose(overlay: GraphOverlay): SplitOverlay {
  const groups = overlay.edits.filter(
    (e): e is FloatingNodes => e.type === 'addNodes'
  );
  if (groups.length === 0) {
    return { loose: { edits: [] }, active: overlay };
  }

  // Groups wired to each other are judged together.
  const parent = new Map(groups.map((g) => [g.id, g.id]));
  const root = (id: string): string => {
    let at = id;
    for (let up = parent.get(at); up !== undefined && up !== at;) {
      at = up;
      up = parent.get(at);
    }

    return at;
  };
  const groupOf = (node: string): string | undefined => {
    const id = floatingGroup(node);
    return id !== undefined && parent.has(id) ? id : undefined;
  };
  for (const edit of overlay.edits) {
    if (edit.type !== 'addEdge') {
      continue;
    }

    const from = groupOf(edit.from.node);
    const to = groupOf(edit.to.node);
    if (from !== undefined && to !== undefined) {
      parent.set(root(from), root(to));
    }
  }

  // Wired into the code: its exec pins or a value it feeds.
  const active = new Set<string>();
  for (const edit of overlay.edits) {
    if (edit.type !== 'addEdge') {
      continue;
    }

    const from = groupOf(edit.from.node);
    const to = groupOf(edit.to.node);
    if (from !== undefined && to === undefined) {
      active.add(root(from));
    } else if (from === undefined && to !== undefined && edit.kind === 'exec') {
      active.add(root(to));
    }
  }

  const isLoose = (node: string): boolean => {
    const id = groupOf(node);
    return id !== undefined && !active.has(root(id));
  };
  const loose = (edit: GraphEdit): boolean => {
    switch (edit.type) {
      case 'addNodes': {
        return !active.has(root(edit.id));
      }

      case 'removeNode': {
        return isLoose(edit.node);
      }

      default: {
        // A wire inside loose groups, or from the code into one.
        return isLoose(edit.to.node);
      }
    }
  };
  return {
    loose: { edits: overlay.edits.filter((e) => loose(e)) },
    active: { edits: overlay.edits.filter((e) => !loose(e)) },
  };
}

const LOOSE_PREFIX = '~loose|';
const LOOSE_WIRE_PREFIX = '~loosewire|';
/** Characters of code per layout key (keys are at most 512 long). */
const CHUNK = 300;

/** A loose group as stored with the layout: its code, to make it again. */
export interface StoredLoose {
  id: string;
  fnId: string;
  /** Statements (`true`) or a value. */
  statement: boolean;
  code: string;
}

/** Whether a layout key stores loose graph-only nodes. */
export function isLooseKey(key: string): boolean {
  return key.startsWith(LOOSE_PREFIX) || key.startsWith(LOOSE_WIRE_PREFIX);
}

/**
 * Layout entries for loose groups (they live with the file's layout, like
 * comment box colors): each group's code in parts of a key, and the wires
 * from the code into them.
 */
export function looseLayoutKeys(loose: GraphOverlay): Positions {
  const keys: Positions = {};
  for (const edit of loose.edits) {
    if (edit.type === 'addNodes') {
      const statement = edit.nodes.some((n) =>
        n.pins.some((p) => p.kind === 'exec')
      );
      const code = encodeURIComponent(edit.code);
      for (let i = 0, part = 0; i < code.length || part === 0; part++) {
        // Never split an escape (`%20`): end right before it instead.
        let end = Math.min(code.length, i + CHUNK);
        const escape = code.lastIndexOf('%', end - 1);
        if (end < code.length && escape > end - 3) {
          end = escape;
        }

        keys[
          `${LOOSE_PREFIX}${edit.id}|${encodeURIComponent(edit.fnId)}|${statement ? 's' : 'v'}|${part}|${code.slice(i, end)}`
        ] = { x: 0, y: 0 };
        i = end;
      }
    } else if (edit.type === 'addEdge' && !floatingGroup(edit.from.node)) {
      keys[
        `${LOOSE_WIRE_PREFIX}${edit.kind}|${edit.from.node}|${edit.from.pin}|${edit.to.node}|${edit.to.pin}`
      ] = { x: 0, y: 0 };
    }
  }

  return keys;
}

/** The loose groups and wires stored in a layout. */
export function looseFromLayout(positions: Positions): {
  groups: StoredLoose[];
  wires: Array<Extract<GraphEdit, { type: 'addEdge' }>>;
} {
  const parts = new Map<
    string,
    { fnId: string; statement: boolean; code: Map<number, string> }
  >();
  const wires: Array<Extract<GraphEdit, { type: 'addEdge' }>> = [];
  for (const key of Object.keys(positions)) {
    if (key.startsWith(LOOSE_WIRE_PREFIX)) {
      const [kind, fromNode, fromPin, toNode, toPin] = key
        .slice(LOOSE_WIRE_PREFIX.length)
        .split('|');
      if (
        (kind === 'data' || kind === 'exec') &&
        fromNode &&
        fromPin !== undefined &&
        toNode &&
        toPin !== undefined
      ) {
        wires.push({
          type: 'addEdge',
          kind,
          from: { node: fromNode, pin: fromPin },
          to: { node: toNode, pin: toPin },
        });
      }

      continue;
    }

    if (!key.startsWith(LOOSE_PREFIX)) {
      continue;
    }

    const [id, fnId, kind, part, ...rest] = key
      .slice(LOOSE_PREFIX.length)
      .split('|');
    if (!id || fnId === undefined || part === undefined) {
      continue;
    }

    const group = parts.get(id) ?? {
      fnId: decodeURIComponent(fnId),
      statement: kind === 's',
      code: new Map<number, string>(),
    };
    group.code.set(Number(part), rest.join('|'));
    parts.set(id, group);
  }

  const groups = [...parts].map(([id, group]) => ({
    id,
    fnId: group.fnId,
    statement: group.statement,
    code: decodeURIComponent(
      [...group.code]
        .toSorted((a, b) => a[0] - b[0])
        .map(([, chunk]) => chunk)
        .join('')
    ),
  }));
  return { groups, wires };
}
