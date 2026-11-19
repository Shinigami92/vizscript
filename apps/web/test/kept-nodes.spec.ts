import type {
  FloatingNodes,
  GraphDocument,
  GraphEdit,
  GraphOp,
  GraphOverlay,
  LayoutPatch,
  Point,
} from '@vizscript/core';
import { applyTextEdits, EMPTY_OVERLAY } from '@vizscript/core';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useKeptNodes } from '../src/components/script-workspace/use-kept-nodes';
import { fakeClient, settle } from './fake-client';

interface Kept {
  after: GraphOverlay;
  layout: LayoutPatch;
}

/** A workspace in miniature: the code, its graph, the overlay. */
function setup(source: string): {
  run: (op: (doc: GraphDocument) => GraphOp) => Promise<Kept | undefined>;
  kept: ReturnType<typeof useKeptNodes>;
  overlay: () => GraphOverlay;
  replaced: () => Kept | undefined;
  places: Map<string, Point>;
} {
  const text = ref(source);
  let doc = parseTypeScript(source, 't.ts');
  let overlay = EMPTY_OVERLAY;
  let last: Kept | undefined;
  let replaced: Kept | undefined;
  const places = new Map<string, Point>();
  const kept = useKeptNodes({
    parsedDoc: () => doc,
    drawnDoc: () => doc,
    text,
    path: () => 't.ts',
    client: fakeClient(),
    imports: () => [],
    placeholder: () => 'undefined',
    positionOf: (id) => places.get(id),
    typeFloating: (edit) => Promise.resolve(edit),
    overlay: () => overlay,
    keep: (_before, after, layout) => {
      overlay = after;
      last = { after, layout };
    },
    replace: (_before, after, layout) => {
      overlay = after;
      replaced = { after, layout };
    },
  });
  // Every node of the code has a place of its own.
  for (const [i, node] of doc.functions.flatMap((f) => f.nodes).entries()) {
    places.set(node.id, { x: i * 100, y: 0 });
  }

  const run = async (
    make: (d: GraphDocument) => GraphOp
  ): Promise<Kept | undefined> => {
    const op = make(doc);
    kept.beforeOp(op);
    const result = applyTypeScriptOp(text.value, op, 't.ts');
    if (!result.ok) {
      throw new Error(result.error);
    }

    const before = text.value;
    text.value = applyTextEdits(before, result.edits);
    doc = parseTypeScript(text.value, 't.ts');
    last = undefined;
    kept.afterParse(doc, { before, edits: result.edits });
    await settle();
    return last;
  };
  return {
    run,
    kept,
    overlay: () => overlay,
    replaced: () => replaced,
    places,
  };
}

function groups(overlay: GraphOverlay): FloatingNodes[] {
  return overlay.edits.filter((e): e is FloatingNodes => e.type === 'addNodes');
}

function titles(group: FloatingNodes | undefined): string[] {
  return (group?.nodes ?? []).map((n) => n.title).toSorted();
}

const LOG =
  'declare function log(v: unknown): void;\nfunction f() {\n  log([{ a: 1 }, { b: 2 }]);\n}\n';

describe('nodes an edit leaves behind', () => {
  it('leaves no `this` behind when every drawn node is deleted', async () => {
    const { run } = setup(
      'class A {\n  b(n: number): number {\n    return n;\n  }\n  c(): number {\n    return this.b(1);\n  }\n}\n'
    );
    // Select all: `this` of `this.b` is drawn as `b`'s Target box.
    const kept = await run((doc) => ({
      type: 'deleteNodes',
      nodeIds: doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => n.kind !== 'entry' && n.title !== 'this')
        .map((n) => n.id),
    }));
    expect(kept).toBeUndefined();
  });

  it('keeps the body of a deleted loop as loose nodes at their places', async () => {
    const { run, places } = setup(
      'declare function g(n: number): void;\nfunction f(items: number[]) {\n  for (const item of items) {\n    if (item > 0) {\n      g(item);\n    }\n  }\n}\n'
    );
    const kept = await run((doc) => ({
      type: 'deleteNodes',
      nodeIds: doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => n.kind === 'forEach')
        .map((n) => n.id),
    }));
    const [group] = groups(kept?.after ?? EMPTY_OVERLAY);
    expect(titles(group)).toEqual(['>', 'Branch', 'g']);
    // Each node keeps the place of the node it stands for.
    const placed = Object.values(kept?.layout ?? {});
    expect(placed).toHaveLength(3);
    expect(
      placed.every((p) => [...places.values()].some((q) => q.x === p?.x))
    ).toBe(true);
  });

  it('keeps the pure inputs of a deleted statement, wired to the code', async () => {
    const { run } = setup(
      'declare function g(n: number): void;\nfunction f(x: number) {\n  g(x + 1);\n}\n'
    );
    const kept = await run((doc) => ({
      type: 'deleteNodes',
      nodeIds: doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => n.title === 'g')
        .map((n) => n.id),
    }));
    const edits = kept?.after.edits ?? [];
    const [group] = groups(kept?.after ?? EMPTY_OVERLAY);
    expect(group?.code).toBe('undefined + 1');
    // `x` is a parameter still in the code: its wire stays (graph-only).
    const wire = edits.find(
      (e): e is Extract<GraphEdit, { type: 'addEdge' }> => e.type === 'addEdge'
    );
    expect(wire?.from.pin).toBe('param0');
    expect(wire?.to.node.startsWith('overlay:')).toBe(true);
  });

  it('keeps nothing when the edit leaves nothing behind', async () => {
    const { run } = setup(
      'declare function g(n: number): void;\nfunction f() {\n  g(1);\n}\n'
    );
    const kept = await run((doc) => ({
      type: 'deleteNodes',
      nodeIds: doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => n.title === 'g')
        .map((n) => n.id),
    }));
    console.log(
      'KEPT',
      JSON.stringify(
        kept?.after.edits.map((e) =>
          e.type === 'addNodes' ? [e.code, e.fnId] : e.type
        )
      )
    );
    expect(kept).toBeUndefined();
  });

  it('deletes one node of a loose group and keeps the rest', async () => {
    const { run, kept, replaced } = setup(LOG);
    const first = await run((doc) => ({
      type: 'deleteNodes',
      nodeIds: doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => n.title === 'log')
        .map((n) => n.id),
    }));
    const [group] = groups(first?.after ?? EMPTY_OVERLAY);
    expect(titles(group)).toEqual(['Make Array', 'Make Object', 'Make Object']);
    const object = group?.nodes.find((n) => n.title === 'Make Object');

    expect(await kept.deleteLoose([object?.id ?? ''])).toBe(true);
    const [rest, ...more] = groups(replaced()?.after ?? EMPTY_OVERLAY);
    expect(more).toEqual([]);
    expect(titles(rest)).toEqual(['Make Array', 'Make Object']);
  });

  it("leaves nodes of the code to the code's delete", async () => {
    const { kept } = setup(LOG);
    const doc = parseTypeScript(LOG, 't.ts');
    const call = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'log');
    expect(await kept.deleteLoose([call?.id ?? ''])).toBe(false);
  });
});
