import type {
  FloatingNodes,
  GraphOp,
  GraphOverlay,
  Positions,
} from '@vizscript/core';
import { applyOverlay, floatingNodes, floatingOutput } from '@vizscript/core';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import type { Ref } from 'vue';
import { ref, shallowRef } from 'vue';
import { useGraphOverlay } from '../src/components/script-workspace/use-graph-overlay';
import { fakeClient, settle } from './fake-client';

const TEXT =
  'declare function g(n: number): void;\nfunction f(x: number) {\n  g(0);\n}\n';

const backend = {
  parse: (text: string) => parseTypeScript(text, 't.ts'),
  applyOp: (text: string, op: GraphOp) => applyTypeScriptOp(text, op, 't.ts'),
};

function group(code: string, id: string): FloatingNodes {
  const made = floatingNodes(
    TEXT,
    { type: 'value', expression: code },
    'fn:f',
    id,
    backend
  );
  if (!made.ok) {
    throw new Error(made.error);
  }

  return made.edit;
}

/** `b` (`x * 3`) wired into `g`'s argument: it has to be written. */
function wiredIn(): GraphOverlay {
  const active = group('x * 3', 'b');
  const call = parseTypeScript(TEXT, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.title === 'g');
  return {
    edits: [
      active,
      {
        type: 'addEdge',
        kind: 'data',
        from: { node: active.nodes[0]?.id ?? '', pin: 'value' },
        to: { node: call?.id ?? '', pin: 'arg0' },
      },
    ],
  };
}

function setup(
  pinned = shallowRef<Positions>({}),
  source = TEXT
): {
  overlay: ReturnType<typeof useGraphOverlay>;
  text: Ref<string>;
} {
  const text = ref(source);
  const parsed = parseTypeScript(source, 't.ts');
  const doc = shallowRef(parsed);
  const overlay = useGraphOverlay(
    {
      pinned,
      patchLayout: (patch) => {
        const next = { ...pinned.value };
        for (const [key, point] of Object.entries(patch)) {
          if (point) {
            next[key] = point;
          } else {
            delete next[key];
          }
        }

        pinned.value = next;
      },
      path: () => 't.ts',
      text,
      client: fakeClient(),
      imports: () => [],
      doc,
      writeCode: (next) => {
        text.value = next;
      },
      changed: (next) => {
        doc.value = applyOverlay(parsed, next);
      },
      record: () => undefined,
      recordCode: () => undefined,
      placeFloating: () => undefined,
      positionOf: () => undefined,
      typeFloating: (edit) => Promise.resolve(edit),
      containerOps: () => undefined,
      writing: () => undefined,
      placed: () => undefined,
      show: () => undefined,
    },
    undefined
  );
  return { overlay, text };
}

describe('loose graph-only nodes', () => {
  it("don't hold the code back", () => {
    const { overlay } = setup();
    overlay.setOverlay({ edits: [group('x * 2', 'a')] });
    expect(overlay.outOfSync.value).toBe(false);
    overlay.setOverlay(wiredIn());
    expect(overlay.outOfSync.value).toBe(true);
  });

  it('stay when the other graph-only edits are discarded', () => {
    const { overlay } = setup();
    const loose = group('x * 2', 'a');
    overlay.setOverlay({ edits: [loose, ...wiredIn().edits] });
    overlay.discard();
    expect(overlay.overlay.value.edits).toEqual([loose]);
  });

  it('stay when the other graph-only edits are written as code', async () => {
    const { overlay, text } = setup();
    const loose = group('x * 2', 'a');
    overlay.setOverlay({ edits: [loose, ...wiredIn().edits] });
    await overlay.resolve();
    await settle();
    expect(text.value).toContain('  g(x * 3);\n');
    expect(overlay.overlay.value.edits).toEqual([loose]);
  });

  it('are stored again under the new ids of the code they read', () => {
    const pinned = shallowRef<Positions>({});
    const { overlay } = setup(pinned);
    const loose = group('x + 1', 'a');
    const readFrom = (node: string): GraphOverlay => ({
      edits: [
        loose,
        {
          type: 'addEdge',
          kind: 'data',
          from: { node, pin: 'value' },
          to: { node: loose.nodes[0]?.id ?? '', pin: 'a' },
        },
      ],
    });
    const wireKeys = (): string[] =>
      Object.keys(pinned.value).filter((k) => k.startsWith('~loosewire|'));

    overlay.setOverlay(readFrom('fn:f/getVar:x#0'));
    expect(wireKeys()).toHaveLength(1);
    expect(wireKeys()[0]).toContain('fn:f/getVar:x#0');

    // A re-parse gave the Get another id: the stored wire follows it.
    overlay.followCode(readFrom('fn:f/getVar:x#1'));
    expect(wireKeys()).toHaveLength(1);
    expect(wireKeys()[0]).toContain('fn:f/getVar:x#1');
    expect(overlay.overlay.value).toEqual(readFrom('fn:f/getVar:x#1'));

    // Deleted: its entries leave the layout.
    overlay.setOverlay({ edits: [] });
    expect(Object.keys(pinned.value)).toEqual([]);
  });
});

describe('a node picked from a value', () => {
  it('writes a function input by its name, wired to `this`', async () => {
    const { overlay } = setup();
    const entry = parseTypeScript(TEXT, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.kind === 'entry' && n.title === 'f');
    expect(
      await overlay.floatValueUse(
        {
          type: 'useValue',
          pin: { node: entry?.id ?? '', pin: 'param0' },
          expression: '$value.toFixed(2)',
        },
        'undefined'
      )
    ).toBe(true);
    await settle();
    const [made, ...rest] = overlay.overlay.value.edits;
    expect(made?.type === 'addNodes' && made.code).toBe('x.toFixed(2);');
    // The input's wire is part of the new nodes; nothing else is fed.
    expect(rest).toEqual([]);
    const call =
      made?.type === 'addNodes'
        ? made.nodes.find((n) => n.title === 'toFixed')
        : undefined;
    expect(made?.type === 'addNodes' && made.edges).toContainEqual(
      expect.objectContaining({
        from: { node: entry?.id, pin: 'param0' },
        to: { node: call?.id, pin: 'target' },
      })
    );
  });
});

describe('Promote to Variable', () => {
  it('floats the SET of an unused value, out of the flow', async () => {
    const code =
      'declare function g(n: number): void;\nfunction f(x: number) {\n  x * 2;\n  g(0);\n}\n';
    const { overlay, text } = setup(undefined, code);
    const times = parseTypeScript(code, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === '*');
    expect(
      await overlay.floatPromote({
        type: 'promote',
        pin: { node: times?.id ?? '', pin: 'result' },
        name: 'twice',
      })
    ).toBe(true);
    await settle();
    // The value leaves the code; its SET floats with no exec wires.
    expect(text.value).not.toContain('x * 2');
    const [made, ...rest] = overlay.overlay.value.edits;
    expect(made?.type === 'addNodes' && made.code).toBe('const twice = x * 2;');
    expect(rest).toEqual([]);
  });

  it('floats the SET of a floating value with its nodes', async () => {
    const { overlay } = setup();
    const value = group('x * 3', 'a');
    overlay.setOverlay({ edits: [value] });
    const out = floatingOutput(value);
    expect(
      await overlay.floatPromote({
        type: 'promote',
        pin: out ?? { node: '', pin: '' },
        name: 'y',
      })
    ).toBe(true);
    await settle();
    const edits = overlay.overlay.value.edits;
    expect(edits.map((e) => e.type === 'addNodes' && e.code)).toEqual([
      'const y = x * 3;',
    ]);
  });

  it('keeps values in the flow for the code', async () => {
    const { overlay } = setup();
    const call = parseTypeScript(TEXT, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === 'g');
    expect(
      await overlay.floatPromote({
        type: 'promote',
        pin: { node: call?.id ?? '', pin: 'return' },
        name: 'y',
      })
    ).toBe(false);
  });
});
