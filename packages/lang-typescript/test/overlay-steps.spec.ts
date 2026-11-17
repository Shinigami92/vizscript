import type {
  FloatingNodes,
  GraphDocument,
  GraphNode,
  GraphOp,
  GraphOverlay,
  OpResult,
} from '@vizscript/core';
import {
  applyOverlay,
  EMPTY_OVERLAY,
  graphEditsFor,
  placedNodes,
  resolveOverlay,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const text = 'function f(n: number) {\n  console.log(n);\n}\n';

/** The graph-only removal of the wire into `console.log`. */
function cutOverlay(): GraphOverlay {
  const doc = parseTypeScript(text);
  const log = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === 'log');
  const shown = applyOverlay(doc, EMPTY_OVERLAY);
  const edits = graphEditsFor(shown, {
    type: 'disconnect',
    pin: { node: log?.id ?? '', pin: 'arg0' },
  });
  return { edits: edits ?? [] };
}

/** The TypeScript backend, with every op answered by `answer`. */
function backendAnswering(answer: () => OpResult): {
  parse: (t: string) => GraphDocument;
  applyOp: (t: string, op: GraphOp) => OpResult;
} {
  return { parse: (t) => parseTypeScript(t), applyOp: () => answer() };
}

describe('writing graph-only edits step by step', () => {
  it('writes them with the real backend', () => {
    const result = resolveOverlay(text, cutOverlay(), {
      parse: (t) => parseTypeScript(t),
      applyOp: applyTypeScriptOp,
    });
    expect(result.status).toBe('synced');
  });

  it('stops at a step that would break the code', () => {
    const result = resolveOverlay(
      text,
      cutOverlay(),
      backendAnswering(() => ({
        ok: true,
        edits: [{ start: 0, end: 0, text: ')))' }],
      }))
    );
    expect(result.status).toBe('pending');
    expect(result.status === 'pending' && result.issues[0]?.message).toMatch(
      /^Writing this would break the code/
    );
    // It names the node it was about.
    expect(result.status === 'pending' && result.issues[0]?.node).not.toBe('');
  });

  it('reports a step whose edits cannot be applied', () => {
    const result = resolveOverlay(
      text,
      cutOverlay(),
      backendAnswering(() => ({
        ok: true,
        edits: [
          { start: 0, end: 10, text: '' },
          { start: 5, end: 12, text: '' },
        ],
      }))
    );
    expect(result.status === 'pending' && result.issues[0]?.message).toMatch(
      /^The code could not be written/
    );
  });
});

describe('placing written floating nodes', () => {
  const before = 'function f() {\n  start();\n}\n';
  const group = {
    type: 'addNodes' as const,
    id: 'g1',
    code: 'other();',
    nodes: [
      {
        ...(parseTypeScript('function f() {\n  other();\n}\n')
          .functions.flatMap((f) => f.nodes)
          .find((n) => n.title === 'other') as GraphNode),
        id: 'overlay:g1/fn:f/call:x#0',
      },
    ],
    edges: [],
  };

  function placedFor(after: string): Map<string, string> {
    const at = before.indexOf('}');
    return placedNodes(
      parseTypeScript(before),
      parseTypeScript(after),
      {
        before,
        edits: [
          { start: at, end: at, text: after.slice(at, after.length - 2) },
        ],
      },
      group as unknown as FloatingNodes
    );
  }

  it('takes the only new node of its kind when the title differs', () => {
    expect(
      placedFor('function f() {\n  start();\n  renamed();\n}\n').size
    ).toBe(1);
  });

  it('takes none when several new nodes of its kind could be it', () => {
    expect(
      placedFor('function f() {\n  start();\n  a();\n  b();\n}\n').size
    ).toBe(0);
  });
});
