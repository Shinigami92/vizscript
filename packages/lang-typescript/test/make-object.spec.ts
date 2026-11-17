import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, canAddPin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function makeObject(text: string): GraphNode | undefined {
  return parseTypeScript(text, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeObject');
}

function addPin(text: string, name?: string): string {
  return apply(text, {
    type: 'addArgument',
    node: makeObject(text)?.id ?? '',
    name,
  });
}

function removePin(text: string, pin: string): string {
  return apply(text, {
    type: 'removeArgument',
    pin: { node: makeObject(text)?.id ?? '', pin },
  });
}

describe('Make Object (UE Add pin)', () => {
  it('has Add pin', () => {
    const node = makeObject('const o = { a: 1 };\n');
    expect(node && canAddPin(node)).toBe(true);
  });

  it('adds an empty entry with the given key', () => {
    expect(addPin('const o = { a: 1 };\n', 'b')).toBe(
      'const o = { a: 1, b: undefined };\n'
    );
    expect(addPin('const o = {};\n', 'b')).toBe(
      'const o = { b: undefined };\n'
    );
    expect(addPin('const o = { a: 1 };\n', 'two words')).toBe(
      "const o = { a: 1, 'two words': undefined };\n"
    );
    expect(addPin('const o = {\n  a: 1,\n};\n', 'b')).toBe(
      'const o = {\n  a: 1,\n  b: undefined,\n};\n'
    );
  });

  it('needs a new key', () => {
    expect(() => addPin('const o = { a: 1 };\n')).toThrow(
      'A new entry needs a key.'
    );
    expect(() => addPin('const o = { a: 1 };\n', 'a')).toThrow(
      '"a" is in the object already.'
    );
  });

  it('removes an entry with its comma', () => {
    const text = 'declare const c: number;\nconst o = { a: 1, b: 2, c };\n';
    expect(removePin(text, 'p1')).toBe(
      'declare const c: number;\nconst o = { a: 1, c };\n'
    );
    expect(removePin(text, 'p2')).toBe(
      'declare const c: number;\nconst o = { a: 1, b: 2 };\n'
    );
  });

  it('renames a key', () => {
    for (const [text, pin, key, expected] of [
      ['const o = { a: 1, b: 2 };\n', 'p1', 'c', 'const o = { a: 1, c: 2 };\n'],
      ["const o = { 'a': 1 };\n", 'p0', 'b', "const o = { 'b': 1 };\n"],
      ['const o = { a: 1 };\n', 'p0', 'my key', "const o = { 'my key': 1 };\n"],
      [
        'const o = { length };\n',
        'p0',
        'size',
        'const o = { size: length };\n',
      ],
    ] as const) {
      expect(
        apply(text, {
          type: 'renameEntry',
          pin: { node: makeObject(text)?.id ?? '', pin },
          key,
        })
      ).toBe(expected);
    }
  });

  it('refuses a key that is taken', () => {
    const text = 'const o = { a: 1, b: 2 };\n';
    const result = applyTypeScriptOp(
      text,
      {
        type: 'renameEntry',
        pin: { node: makeObject(text)?.id ?? '', pin: 'p1' },
        key: 'a',
      },
      't.ts'
    );
    expect(result.ok ? '' : result.error).toBe('"a" is in the object already.');
  });
});
