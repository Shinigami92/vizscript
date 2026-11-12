import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 'test.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const TEXT = [
  'function greet(person: string, times = 1): string {',
  '  return person.repeat(times);',
  '}',
  'greet("Jane", 2);',
  'greet("Joe");',
  '',
].join('\n');

describe('function signatures', () => {
  it('adds inputs and updates calls that pass every argument', () => {
    expect(
      apply('function f(a: number) {}\nf(1);\nf();\n', {
        type: 'addParameter',
        symbol: 'function:f',
        name: 'label',
        typeText: 'string',
        argument: "''",
      })
    ).toBe("function f(a: number, label: string) {}\nf(1, '');\nf();\n");
    // After a parameter with a default the new one gets a default too.
    expect(
      apply(TEXT, {
        type: 'addParameter',
        symbol: 'function:greet',
        name: 'loud',
      })
    ).toContain('times = 1, loud = undefined): string');
    expect(
      apply('function f() {}\nf();\n', {
        type: 'addParameter',
        symbol: 'function:f',
        name: 'a',
      })
    ).toBe('function f(a) {}\nf(undefined);\n');
  });

  it('removes and moves inputs with the arguments of calls', () => {
    expect(
      apply(TEXT, {
        type: 'removeParameter',
        symbol: 'function:greet',
        index: 0,
      })
    ).toBe(
      TEXT.replace('person: string, ', '')
        .replace('greet("Jane", 2)', 'greet(2)')
        .replace('greet("Joe")', 'greet()')
    );
    expect(
      apply(TEXT, {
        type: 'moveParameter',
        symbol: 'function:greet',
        from: 1,
        to: 0,
      })
    ).toBe(
      TEXT.replace(
        'person: string, times = 1',
        'times = 1, person: string'
      ).replace('greet("Jane", 2)', 'greet(2, "Jane")')
    );
  });

  it('renames, types and defaults inputs, and sets the return type', () => {
    expect(
      apply(TEXT, {
        type: 'renameParameter',
        symbol: 'function:greet',
        index: 0,
        name: 'who',
      })
    ).toContain(
      'function greet(who: string, times = 1): string {\n  return who.repeat(times);'
    );
    expect(
      apply(TEXT, {
        type: 'setParameterType',
        symbol: 'function:greet',
        index: 1,
        typeText: 'number',
      })
    ).toContain('times: number = 1');
    expect(
      apply(TEXT, {
        type: 'setParameterValue',
        symbol: 'function:greet',
        index: 1,
        value: null,
        kind: 'expression',
      })
    ).toContain('(person: string, times): string');
    expect(
      apply(TEXT, {
        type: 'setReturnType',
        symbol: 'function:greet',
        typeText: null,
      })
    ).toContain('function greet(person: string, times = 1) {');
    expect(
      apply('class A {\n  run() {}\n  go() { this.run(); }\n}\n', {
        type: 'setReturnType',
        symbol: 'method:A.run',
        typeText: 'void',
      })
    ).toBe('class A {\n  run(): void {}\n  go() { this.run(); }\n}\n');
    expect(
      apply('class A {\n  run(a) {}\n  go() { this.run(1); }\n}\n', {
        type: 'removeParameter',
        symbol: 'method:A.run',
        index: 0,
      })
    ).toBe('class A {\n  run() {}\n  go() { this.run(); }\n}\n');
  });
});

describe('lone values (UE: a Get node on its own)', () => {
  it('adds a value statement that shows as unconnected nodes', () => {
    const text = 'function f(a: number) {\n  run();\n}\n';
    const result = applyTypeScriptOp(
      text,
      {
        type: 'addNode',
        template: { type: 'value', expression: 'a' },
        after: {
          node:
            parseTypeScript(text, 't.ts')
              .functions.find((fn) => fn.name === 'f')
              ?.nodes.find((n) => n.title === 'run')?.id ?? '',
          pin: 'then',
        },
      },
      't.ts'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'function f(a: number) {\n  run();\n  a;\n}\n'
    );
    expect(
      apply('const o = 1;\n', {
        type: 'addNode',
        template: { type: 'value', expression: '{ a: o }' },
      })
    ).toBe('const o = 1;\n({ a: o });\n');
  });
});
