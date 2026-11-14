import type {
  FloatingNodes,
  FlowTemplate,
  GraphDocument,
  GraphNode,
  GraphOp,
  LayoutOptions,
  NodeTemplate,
  Point,
  Positions,
  TextChange,
} from '@vizscript/core';
import { layoutDocument, renamedNodes } from '@vizscript/core';

/** Where the node of an op goes once the op's result is parsed. */
export interface PendingPlacement {
  world: Point;
  known: Set<string>;
  /** Prefers the node the user asked for over helper nodes of the edit. */
  matches?: (node: GraphNode) => boolean;
  /** The node written as this code (`greeter()` given to an input). */
  code?: string;
  /**
   * Select afterwards: all new nodes (pasted ones), or only the placed one
   * (the call of collapsed nodes), like UE.
   */
  select?: 'fresh' | 'added';
}

/** Recognizes the node an `addNode` op creates (by kind and name). */
export function templateMatcher(
  template: NodeTemplate
): (node: GraphNode) => boolean {
  switch (template.type) {
    case 'call': {
      return (n) => n.kind === 'call' && n.title === template.callee;
    }

    case 'setVar': {
      return (n) => n.kind === 'setVar' && n.title === `Set ${template.name}`;
    }

    case 'branch': {
      return (n) => n.kind === 'branch';
    }

    case 'return': {
      return (n) => n.kind === 'return';
    }

    case 'value': {
      const expression = template.expression.trim();
      return (n) =>
        n.purity === 'pure' &&
        (n.title === expression || n.title === expression.split('.').at(-1));
    }

    case 'code': {
      // Pasted statements: the first one goes where the paste happened.
      return (n) => n.purity === 'impure';
    }

    case 'flow': {
      // A counting `for` is a loop in TypeScript, a for-each elsewhere.
      const kinds: Record<FlowTemplate, ReadonlyArray<string>> = {
        forEach: ['forEach'],
        forRange: ['forEach', 'loop'],
        while: ['loop'],
        switch: ['switch'],
        try: ['try'],
        throw: ['throw'],
        break: ['break'],
        continue: ['continue'],
      };
      const wanted = kinds[template.flow];
      return (n) => wanted.includes(n.kind);
    }
  }
}

export function allNodeIds(d: GraphDocument | null): Set<string> {
  return new Set(d?.functions.flatMap((f) => f.nodes.map((n) => n.id)) ?? []);
}

/**
 * New nodes go where the wire was dropped or the menu was opened: the
 * placement of an op with a position, `null` for other ops.
 */
export function placementFor(
  op: GraphOp,
  doc: GraphDocument | null
): PendingPlacement | null {
  const placed = op.type === 'withImport' ? op.op : op;
  if (
    (placed.type === 'addNode' ||
      placed.type === 'callWith' ||
      placed.type === 'useValue' ||
      placed.type === 'setInput' ||
      placed.type === 'promote' ||
      placed.type === 'extract' ||
      placed.type === 'collapseToFunction') &&
    placed.position
  ) {
    let matches: ((node: GraphNode) => boolean) | undefined;
    if (placed.type === 'addNode') {
      matches = templateMatcher(placed.template);
    } else if (placed.type === 'promote' || placed.type === 'extract') {
      // The new SET node, not the call that moved into it.
      const title = `Set ${placed.name}`;
      matches = (n) => n.kind === 'setVar' && n.title === title;
    } else if (placed.type === 'collapseToFunction') {
      // The call of the new function (`name`, `this.name`, `self.name`).
      const name = placed.name;
      matches = (n) =>
        n.kind === 'call' && (n.title === name || n.title.endsWith(`.${name}`));
    }

    return {
      world: placed.position,
      known: allNodeIds(doc),
      matches,
      ...(placed.type === 'setInput' ? { code: placed.expression.trim() } : {}),
      // Like UE, a node just placed is selected (pasted code: all of it).
      select:
        placed.type === 'addNode' && placed.template.type === 'code'
          ? 'fresh'
          : placed.type === 'collapseToFunction' || placed.type === 'addNode'
            ? 'added'
            : undefined,
    };
  }

  return null;
}

/**
 * Positions of the nodes an op added (the asked-for one where the user
 * wanted it, the others around it) and the nodes to select afterwards.
 */
export function placeNewNodes(
  placement: PendingPlacement,
  previous: GraphDocument | null,
  next: GraphDocument,
  change: TextChange,
  source: string,
  pinned: Positions,
  layoutOptions: LayoutOptions
): { placed?: Positions; selectAfter?: string[] } {
  const { world, known, matches, code, select } = placement;
  // Old nodes whose id changed with their text (an `if` around the new
  // statement) are followed, not new.
  const followed = new Set(
    previous ? renamedNodes(previous, next, change).values() : []
  );
  const fresh = next.functions
    .flatMap((f) => f.nodes)
    .filter((n) => !known.has(n.id) && !followed.has(n.id));
  // The node asked for (also a pure one, e.g. a lone Get), else the first
  // new statement, else the root of a new expression (output not wired).
  const used = new Set(
    next.functions.flatMap((f) => f.edges.map((e) => e.from.node))
  );
  const added =
    (matches && fresh.find(matches)) ??
    (code === undefined
      ? undefined
      : fresh.find((n) => source.slice(n.range.start, n.range.end) === code)) ??
    fresh.find((n) => n.purity === 'impure') ??
    fresh.find((n) => !used.has(n.id));
  let placed: Positions | undefined;
  if (added) {
    // The other new nodes of the edit (a hoisted call, the parts of an
    // expression) keep their place relative to it, as the auto layout
    // arranges them, instead of landing next to old neighbors.
    const auto = layoutDocument(next, layoutOptions, {});
    const origin = auto[added.id];
    placed = { [added.id]: world };
    for (const node of origin ? fresh : []) {
      const p = auto[node.id];
      // Old nodes whose text changed kept their place (reconciled above).
      if (node.id !== added.id && p && origin && !pinned[node.id]) {
        placed[node.id] = {
          x: world.x + p.x - origin.x,
          y: world.y + p.y - origin.y,
        };
      }
    }
  }

  let selectAfter: string[] | undefined;
  if (select === 'fresh' && fresh.length > 0) {
    selectAfter = fresh.map((n) => n.id);
  } else if (select === 'added' && added) {
    selectAfter = [added.id];
  }

  return { placed, selectAfter };
}

function runs(n: GraphNode): boolean {
  return n.pins.some((p) => p.kind === 'exec' && p.direction === 'in');
}

/**
 * Where floating nodes go: their statements in a row from the drop point,
 * each value left of the node it feeds.
 */
export function floatingLayout(edit: FloatingNodes, world: Point): Positions {
  const positions: Positions = {};
  const statements = edit.nodes.filter(runs);
  for (const [i, node] of statements.entries()) {
    positions[node.id] = { x: world.x + i * 260, y: world.y };
  }

  const values = edit.nodes.filter((n) => !runs(n)).toReversed();
  if (statements.length === 0 && values[0]) {
    positions[values[0].id] = { ...world };
  }

  // Values feed nodes placed before them (code order is inside out).
  const below = new Map<string, number>();
  for (let pass = 0; pass < values.length; pass++) {
    for (const node of values) {
      if (positions[node.id]) {
        continue;
      }

      const target = edit.edges.find(
        (e) => e.from.node === node.id && positions[e.to.node]
      )?.to.node;
      const at = target ? positions[target] : undefined;
      if (target && at) {
        const k = below.get(target) ?? 0;
        below.set(target, k + 1);
        positions[node.id] = { x: at.x - 200, y: at.y + 40 + k * 70 };
      }
    }
  }

  for (const [i, node] of values.entries()) {
    positions[node.id] ??= { x: world.x - 200 * (i + 1), y: world.y };
  }

  return positions;
}
