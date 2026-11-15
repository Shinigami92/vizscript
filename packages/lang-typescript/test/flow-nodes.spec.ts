import type { FlowTemplate } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const TEXT = 'function f() {\n  start();\n}\n';

function addFlow(flow: FlowTemplate): { text: string; kinds: string[] } {
  const call = parseTypeScript(TEXT, 't.ts')
    .functions.find((fn) => fn.name === 'f')
    ?.nodes.find((n) => n.kind === 'call');
  const result = applyTypeScriptOp(
    TEXT,
    {
      type: 'addNode',
      template: { type: 'flow', flow },
      after: { node: call?.id ?? '', pin: 'then' },
    },
    't.ts'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  const text = applyTextEdits(TEXT, result.edits);
  const kinds =
    parseTypeScript(text, 't.ts')
      .functions.find((fn) => fn.name === 'f')
      ?.nodes.map((n) => n.kind) ?? [];
  return { text, kinds };
}

describe('flow-control nodes', () => {
  it('adds loops', () => {
    expect(addFlow('forEach')).toMatchObject({
      text: 'function f() {\n  start();\n  for (const item of undefined) {\n  }\n}\n',
      kinds: expect.arrayContaining(['forEach']),
    });
    // A counting loop is one For Loop node with index pins (like UE).
    expect(addFlow('forRange').kinds).toEqual(['entry', 'call', 'forEach']);
    expect(addFlow('while').kinds).toContain('loop');
  });

  it('adds switch and try', () => {
    expect(addFlow('switch')).toMatchObject({
      text: 'function f() {\n  start();\n  switch (undefined) {\n    case 0:\n      break;\n    default:\n      break;\n  }\n}\n',
      kinds: expect.arrayContaining(['switch']),
    });
    expect(addFlow('try').kinds).toContain('try');
    expect(addFlow('throw').kinds).toContain('throw');
  });

  it('adds one node, its empty inputs are pin values (like UE)', () => {
    for (const flow of ['forEach', 'forRange', 'throw'] as const) {
      const { kinds } = addFlow(flow);
      // The entry, `start()` and the new node: no Make Array, no `new Error`.
      expect(kinds).toHaveLength(3);
    }
  });
});
