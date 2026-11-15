import type {
  FloatingNodes,
  GraphOp,
  GraphOverlay,
  Positions,
} from '@vizscript/core';
import { applyOverlay, floatingNodes } from '@vizscript/core';
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

function setup(): {
  overlay: ReturnType<typeof useGraphOverlay>;
  text: Ref<string>;
} {
  const text = ref(TEXT);
  const parsed = parseTypeScript(TEXT, 't.ts');
  const doc = shallowRef(parsed);
  const overlay = useGraphOverlay(
    {
      pinned: shallowRef<Positions>({}),
      patchLayout: () => undefined,
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
});
