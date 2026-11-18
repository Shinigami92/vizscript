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
  it('floats a statement made from it (Set Array Elem)', async () => {
    const code = "function f(items: string[]) {\n  items.push('a');\n}\n";
    const { overlay, text } = setup(undefined, code);
    const entry = parseTypeScript(code, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.kind === 'entry' && n.title === 'f');
    expect(
      await overlay.floatValueUse(
        {
          type: 'useValue',
          pin: { node: entry?.id ?? '', pin: 'param0' },
          expression: "$value[0] = ''",
        },
        'undefined'
      )
    ).toBe(true);
    await settle();
    expect(text.value).toBe(code);
    const [made] = overlay.overlay.value.edits;
    expect(made?.type === 'addNodes' && made.code).toBe("items[0] = '';");
    expect(made?.type === 'addNodes' && made.nodes.map((n) => n.title)).toEqual(
      ['Set Array Elem']
    );
  });

  it('floats plain values too (GET, LAST INDEX), like calls', async () => {
    const code = "function f(items: string[]) {\n  items.push('a');\n}\n";
    const { overlay, text } = setup(undefined, code);
    const entry = parseTypeScript(code, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.kind === 'entry' && n.title === 'f');
    for (const expression of ['$value[0]', '$value.length - 1']) {
      expect(
        await overlay.floatValueUse(
          {
            type: 'useValue',
            pin: { node: entry?.id ?? '', pin: 'param0' },
            expression,
          },
          'undefined'
        )
      ).toBe(true);
    }

    await settle();
    // Nothing in the code until they are wired.
    expect(text.value).toBe(code);
    expect(
      overlay.overlay.value.edits.map((e) => e.type === 'addNodes' && e.code)
    ).toEqual(['items[0]', 'items.length - 1']);
  });

  it('feeds a value of the code into a floating one by a wire', async () => {
    const code =
      'declare function g(): number;\nfunction f() {\n  const n = g();\n}\n';
    const { overlay, text } = setup(undefined, code);
    const call = parseTypeScript(code, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === 'g');
    expect(
      await overlay.floatValueUse(
        {
          type: 'useValue',
          pin: { node: call?.id ?? '', pin: 'return' },
          expression: '$value - 1',
        },
        'undefined'
      )
    ).toBe(true);
    await settle();
    expect(text.value).toBe(code);
    const [made, wire] = overlay.overlay.value.edits;
    expect(made?.type === 'addNodes' && made.code).toBe('undefined - 1');
    expect(wire).toEqual(
      expect.objectContaining({
        type: 'addEdge',
        from: { node: call?.id, pin: 'return' },
      })
    );
  });

  it('leaves `await` to the code, around the value where it stands', async () => {
    const { overlay } = setup();
    const call = parseTypeScript(TEXT, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === 'g');
    expect(
      await overlay.floatValueUse(
        {
          type: 'useValue',
          pin: { node: call?.id ?? '', pin: 'return' },
          expression: 'await $value',
          awaits: true,
        },
        'undefined'
      )
    ).toBe(false);
  });

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

describe('a value for a floating call', () => {
  it('fills a missing argument (Details, inline box)', async () => {
    const { overlay } = setup();
    const call = group('g()', 'a');
    overlay.setOverlay({ edits: [call] });
    const node = call.nodes.find((n) => n.title === 'g')?.id ?? '';
    expect(
      await overlay.floatLiteral({
        type: 'setLiteral',
        node,
        pin: 'param:n',
        value: '1',
      })
    ).toBe(true);
    await settle();
    expect(
      overlay.overlay.value.edits.map((e) => e.type === 'addNodes' && e.code)
    ).toEqual(['g(1);']);
  });

  it('replaces a value it has (Set Array Elem’s index and item)', async () => {
    const { overlay } = setup();
    const write = group('[1, 2][0] = 5', 'a');
    overlay.setOverlay({ edits: [write] });
    const node = write.nodes.find((n) => n.title === 'Set Array Elem')?.id;
    expect(
      await overlay.floatLiteral({
        type: 'setLiteral',
        node: node ?? '',
        pin: 'item',
        value: '7',
      })
    ).toBe(true);
    await settle();
    expect(
      overlay.overlay.value.edits.map((e) => e.type === 'addNodes' && e.code)
    ).toEqual(['[1, 2][0] = 7;']);
  });

  it('leaves the code’s nodes to the code', async () => {
    const { overlay } = setup();
    const call = parseTypeScript(TEXT, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === 'g');
    expect(
      await overlay.floatLiteral({
        type: 'setLiteral',
        node: call?.id ?? '',
        pin: 'arg0',
        value: '2',
      })
    ).toBe(false);
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
