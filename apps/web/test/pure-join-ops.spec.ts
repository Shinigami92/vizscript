import type { GraphDocument, GraphNode } from '@vizscript/core';
import { applyTextEdits, foldVias, joinKey, viaJoins } from '@vizscript/core';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import {
  fanOut,
  isPureCopy,
  pureJoins,
  withCopyParts,
} from '../src/components/script-workspace/pure-join-ops';

const TEXT =
  'declare function g(n: number): void;\nfunction f(x: number) {\n  g(x + 1);\n  g(x + 1);\n}\n';

/** The graph with the second `x + 1` joined into the first (user wired). */
function joined(): {
  shown: GraphDocument;
  drawn: GraphDocument;
  host: GraphNode;
  copy: GraphNode;
} {
  const shown = parseTypeScript(TEXT, 't.ts');
  const [host, copy] = shown.functions
    .flatMap((f) => f.nodes)
    .filter((n) => n.title === '+');
  if (!host || !copy) {
    throw new Error('no +');
  }

  const drawn = foldVias(
    shown,
    new Set(),
    viaJoins({ [joinKey(copy.id, host.id)]: { x: 0, y: 0 } })
  );
  return { shown, drawn, host, copy };
}

describe('ops on a joined pure node', () => {
  it('finds the copies the graph draws as their host', () => {
    const { shown, drawn, host, copy } = joined();
    expect(pureJoins(shown, drawn).map((j) => [j.host, j.copy])).toEqual([
      [host.id, copy.id],
    ]);
    expect(isPureCopy(shown, copy.id)).toBe(true);
    expect(withCopyParts(pureJoins(shown, drawn), [copy.id])).toEqual([
      copy.id,
    ]);
  });

  it('writes an edit of the host at its copy too, in one edit', () => {
    const { shown, drawn, host } = joined();
    const op = fanOut(
      { type: 'setLiteral', node: host.id, pin: 'b', value: '2' },
      pureJoins(shown, drawn)
    );
    expect(op.type).toBe('all');
    const result = applyTypeScriptOp(TEXT, op, 't.ts');
    if (!result.ok) {
      throw new Error(result.error);
    }

    expect(applyTextEdits(TEXT, result.edits)).toContain(
      '  g(x + 2);\n  g(x + 2);\n'
    );
  });

  it('leaves ops on other nodes as they are', () => {
    const { shown, drawn } = joined();
    const call = shown.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'g');
    const op = {
      type: 'setLiteral' as const,
      node: call?.id ?? '',
      pin: 'arg0',
      value: '3',
    };
    expect(fanOut(op, pureJoins(shown, drawn))).toBe(op);
  });
});
