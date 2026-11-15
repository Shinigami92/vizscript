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

  it('has a Format pin (UE) first that edits the format on the node', () => {
    const code = 'const s = `Total: ${n} of ${ m } EUR`;\n';
    const text = `${DECL}${code}`;
    const node = parseTypeScript(text, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.kind === 'template');
    const inputs = node?.pins.filter(
      (p) => p.direction === 'in' && p.kind === 'data'
    );
    expect(inputs?.map((p) => p.name)).toEqual(['Format', '{0}', '{1}']);
    expect(inputs?.[0]?.literal?.value).toBe('Total: {0} of {1} EUR');

    const result = applyTypeScriptOp(
      text,
      {
        type: 'setLiteral',
        node: node?.id ?? '',
        pin: 'format',
        value: '{1}, {0} and {2}',
      },
      't.ts'
    );
    expect(
      result.ok && applyTextEdits(text, result.edits).slice(DECL.length)
    ).toBe('const s = `${ m }, ${n} and ${undefined}`;\n');
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

  it('takes no wire into Format: the format is written in the text', () => {
    const text = `${DECL}const label = 'x';\nconst s = \`Total: \${n} EUR\`;\nconsole.log(label);\n`;
    const nodes = parseTypeScript(text, 't.ts').functions.flatMap(
      (f) => f.nodes
    );
    const template = nodes.find((x) => x.kind === 'template');
    const label = nodes.find((x) => x.kind === 'getVar' && x.title === 'label');
    const out = label?.pins.find((p) => p.direction === 'out');
    const result = applyTypeScriptOp(
      text,
      {
        type: 'connect',
        from: { node: label?.id ?? '', pin: out?.id ?? '' },
        to: { node: template?.id ?? '', pin: 'format' },
      },
      't.ts'
    );
    expect(result.ok).toBe(false);
  });
});
