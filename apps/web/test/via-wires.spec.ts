import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  Positions,
} from '@vizscript/core';
import { applyTextEdits, joinKey } from '@vizscript/core';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import type { ShallowRef } from 'vue';
import { computed, shallowRef } from 'vue';
import { useViaWires } from '../src/components/script-workspace/use-via-wires';

const TEXT =
  'declare function g(n: number): void;\nfunction f(x: number) {\n  g(x + 1);\n  g(0);\n}\n';

function setup(text: string): {
  wires: ReturnType<typeof useViaWires>;
  doc: ShallowRef<GraphDocument | null>;
  pinned: ShallowRef<Positions>;
  apply: (op: GraphOp) => {
    text: string;
    next: GraphDocument;
    patch: Positions;
  };
} {
  const doc = shallowRef<GraphDocument | null>(parseTypeScript(text, 't.ts'));
  const pinned = shallowRef<Positions>({});
  const wires = useViaWires({
    shownDoc: computed(() => doc.value),
    parsedDoc: doc,
    pinned,
    autoLayout: () => ({}),
  });
  let current = text;
  const apply = (
    op: GraphOp
  ): { text: string; next: GraphDocument; patch: Positions } => {
    const previous = doc.value ?? undefined;
    wires.beforeOp(op, doc.value);
    const result = applyTypeScriptOp(current, op, 't.ts');
    if (!result.ok) {
      throw new Error(result.error);
    }

    const before = current;
    current = applyTextEdits(current, result.edits);
    const next = parseTypeScript(current, 't.ts');
    doc.value = next;
    const patch = wires.afterParse(previous, next, {
      before,
      edits: result.edits,
    });
    pinned.value = { ...pinned.value, ...patch };
    return { text: current, next, patch };
  };
  return { wires, doc, pinned, apply };
}

function nodes(doc: GraphDocument | null, title: string): GraphNode[] {
  return (doc?.functions ?? [])
    .flatMap((f) => f.nodes)
    .filter((n) => n.title === title);
}

describe('joins of copied pure nodes', () => {
  it('remembers a pure node wired into a second input as one node', () => {
    const { doc, apply } = setup(TEXT);
    const [host] = nodes(doc.value, '+');
    const [, second] = nodes(doc.value, 'g');
    const { text, next, patch } = apply({
      type: 'connect',
      from: { node: host?.id ?? '', pin: 'value' },
      to: { node: second?.id ?? '', pin: 'arg0' },
    });
    // The code copies the expression; the graph draws the copy as its host.
    expect(text).toContain('  g(x + 1);\n  g(x + 1);\n');
    const [first, copy] = nodes(next, '+');
    expect(patch).toEqual({
      [joinKey(copy?.id ?? '', first?.id ?? '')]: { x: 0, y: 0 },
    });
  });

  it('remembers a pure node used in a new expression', () => {
    const { doc, apply } = setup(TEXT);
    const [host] = nodes(doc.value, '+');
    const { next, patch } = apply({
      type: 'useValue',
      pin: { node: host?.id ?? '', pin: 'value' },
      expression: '$value * 2',
    });
    const [first, copy] = nodes(next, '+');
    expect(copy).toBeDefined();
    expect(patch).toEqual({
      [joinKey(copy?.id ?? '', first?.id ?? '')]: { x: 0, y: 0 },
    });
  });

  it('removes just the copy when its wire is broken', () => {
    const { doc, wires, apply } = setup(TEXT);
    const [host] = nodes(doc.value, '+');
    const [, second] = nodes(doc.value, 'g');
    const { next } = apply({
      type: 'connect',
      from: { node: host?.id ?? '', pin: 'value' },
      to: { node: second?.id ?? '', pin: 'arg0' },
    });
    const [, call] = nodes(next, 'g');
    const pin = { node: call?.id ?? '', pin: 'arg0' };
    expect(wires.throughVias({ type: 'disconnect', pin })).toEqual({
      type: 'disconnect',
      pin,
      drop: true,
    });
  });
});
