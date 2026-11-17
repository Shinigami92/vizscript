import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function nodeId(text: string, title: string): string {
  return (
    parseTypeScript(text, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === title)?.id ?? ''
  );
}

const wrap = (body: string): string =>
  `function f() {\n  a();\n${body}  b();\n}\n`;

describe('deleting a statement with its comments', () => {
  it('takes the comment on its line and the directive it opened', () => {
    for (const body of [
      '  console.log(1); // why\n',
      '  console.log(1); /* why */\n',
      '  // oxlint-disable no-console\n  console.log(1);\n  // oxlint-enable no-console\n',
      '  // eslint-disable-next-line no-console\n  console.log(1);\n',
    ]) {
      const text = wrap(body);
      expect(
        apply(text, { type: 'deleteNodes', nodeIds: [nodeId(text, 'log')] })
      ).toBe(wrap(''));
    }
  });

  it('keeps a comment below it that is no closing directive', () => {
    const text = wrap('  console.log(1);\n  // about b\n');
    expect(
      apply(text, { type: 'deleteNodes', nodeIds: [nodeId(text, 'log')] })
    ).toBe(wrap('  // about b\n'));
  });

  it('moves a statement with the comment on its line', () => {
    const text = 'function f() {\n  a();\n  b();\n  c(); // why\n}\n';
    const doc = parseTypeScript(text, 't.ts');
    const a = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'a');
    const c = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'c');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: a?.id ?? '', pin: 'then' },
        to: { node: c?.id ?? '', pin: 'exec' },
      })
    ).toContain('  a();\n  c(); // why\n');
  });
});
