import {
  applyTextEdits,
  templateFormat,
  templateLayout,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const DECL = 'declare const n: number, m: number;\n';

function setFormat(code: string, format: string): string {
  const text = `${DECL}${code}`;
  const node = parseTypeScript(text, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'template');
  const result = applyTypeScriptOp(
    text,
    { type: 'setFormat', node: node?.id ?? '', format },
    't.ts'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits).slice(DECL.length);
}

describe('Format Text', () => {
  it('shows the format with numbered values', () => {
    const text = 'const s = `Total: ${n} of ${ m } EUR`;\n';
    const node = parseTypeScript(text, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.kind === 'template');
    const layout = node ? templateLayout(text, node, '${') : undefined;
    expect(layout && templateFormat(layout)).toBe('Total: {0} of {1} EUR');
  });

  it('writes a new format around the values', () => {
    const code = 'const s = `Total: ${n} EUR`;\n';
    expect(setFormat(code, 'Sum {0} €')).toBe('const s = `Sum ${n} €`;\n');
    expect(setFormat(code, '{0} of {1}')).toBe(
      'const s = `${n} of ${undefined}`;\n'
    );
    expect(setFormat(code, 'no value')).toBe('const s = `no value`;\n');
    expect(setFormat(code, 'a ` b ${0}')).toBe('const s = `a \\` b $${n}`;\n');
    expect(setFormat('const s = `${n} and ${m}`;\n', '{1} before {0}')).toBe(
      'const s = `${m} before ${n}`;\n'
    );
  });
});
