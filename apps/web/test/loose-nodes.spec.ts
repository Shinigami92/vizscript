import type {
  FloatingNodes,
  GraphOp,
  GraphOverlay,
  Point,
  Positions,
} from '@vizscript/core';
import { EMPTY_OVERLAY, floatingNodes, isLooseKey } from '@vizscript/core';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import type { ShallowRef } from 'vue';
import { ref, shallowRef } from 'vue';
import { useLooseNodes } from '../src/components/script-workspace/use-loose-nodes';
import { fakeClient } from './fake-client';

const TEXT = 'function f(x: number) {\n}\n';

function group(code: string, id: string): FloatingNodes {
  const made = floatingNodes(
    TEXT,
    { type: 'value', expression: code },
    'fn:f',
    id,
    {
      parse: (text) => parseTypeScript(text, 't.ts'),
      applyOp: (text: string, op: GraphOp) =>
        applyTypeScriptOp(text, op, 't.ts'),
    }
  );
  if (!made.ok) {
    throw new Error(made.error);
  }

  return made.edit;
}

function setup(): {
  loose: ReturnType<typeof useLooseNodes>;
  pinned: ShallowRef<Positions>;
  overlay: () => GraphOverlay;
} {
  const pinned = shallowRef<Positions>({});
  let overlay = EMPTY_OVERLAY;
  const loose = useLooseNodes({
    pinned,
    patchLayout: (patch: Record<string, Point | null>) => {
      const next = { ...pinned.value };
      for (const [key, value] of Object.entries(patch)) {
        if (value) {
          next[key] = value;
        } else {
          delete next[key];
        }
      }

      pinned.value = next;
    },
    client: fakeClient(),
    text: ref(TEXT),
    path: () => 't.ts',
    imports: () => [],
    typeFloating: (edit) => Promise.resolve(edit),
    overlay: () => overlay,
    setOverlay: (next) => {
      overlay = next;
    },
  });
  return { loose, pinned, overlay: () => overlay };
}

describe('loose nodes in the layout', () => {
  it('stores loose groups with the layout and drops them again', () => {
    const { loose, pinned } = setup();
    loose.store({ edits: [group('x * 2', 'a')] });
    expect(Object.keys(pinned.value).some((key) => isLooseKey(key))).toBe(true);

    // Wired into the code (active): not loose anymore, not stored.
    const active = group('x * 3', 'b');
    const root = active.nodes[0]?.id ?? '';
    loose.store({
      edits: [
        active,
        {
          type: 'addEdge',
          kind: 'data',
          from: { node: root, pin: 'value' },
          to: { node: 'fn:f/call:g#0', pin: 'arg0' },
        },
      ],
    });
    expect(Object.keys(pinned.value).filter((key) => isLooseKey(key))).toEqual(
      []
    );
  });

  it('makes stored groups again after loading', async () => {
    const first = setup();
    const stored = group('x * 2', 'a');
    first.loose.store({ edits: [stored] });

    // A new workspace with the stored layout and no overlay.
    const second = setup();
    second.pinned.value = first.pinned.value;
    await second.loose.restore();
    const [made] = second
      .overlay()
      .edits.filter((e): e is FloatingNodes => e.type === 'addNodes');
    expect(made?.id).toBe('a');
    expect(made?.code).toBe(stored.code);
    // The same code makes the same nodes, so their places fit.
    expect(made?.nodes.map((n) => n.id)).toEqual(stored.nodes.map((n) => n.id));
  });
});
