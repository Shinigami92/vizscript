import type { GraphNode, GraphOp } from '@vizscript/core';
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

function callNode(text: string, title: string): GraphNode {
  const node = parseTypeScript(text, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'call' && n.title === title);
  if (!node) {
    throw new Error(`no call ${title}`);
  }

  return node;
}

function removeArg(text: string, title: string, pin: string): string {
  return apply(text, {
    type: 'removeArgument',
    pin: { node: callNode(text, title).id, pin },
  });
}

const TEXT = [
  'function greet(person: string, times = 2, loud?: boolean): string {',
  '  return person;',
  '}',
  'const user = "Jane";',
  'greet();',
  '',
].join('\n');

describe('argument pins from signatures', () => {
  it('shows every parameter as a typed pin', () => {
    const pins = callNode(TEXT, 'greet')
      .pins.filter((p) => p.direction === 'in' && p.kind === 'data')
      .map((p) => `${p.id}:${p.name}:${p.type}=${p.literal?.value ?? ''}`);
    expect(pins).toEqual([
      'param:person:person:string=',
      'param:times:times:number=2',
      'param:loud:loud:bool=',
    ]);
  });

  it('inserts arguments for values and wires', () => {
    const node = callNode(TEXT, 'greet');
    expect(
      apply(TEXT, {
        type: 'setLiteral',
        node: node.id,
        pin: 'param:person',
        value: 'Joe',
      })
    ).toContain('greet("Joe");');
    // A later parameter fills the skipped ones with placeholders.
    expect(
      apply(TEXT, {
        type: 'setLiteral',
        node: node.id,
        pin: 'param:loud',
        value: 'true',
      })
    ).toContain('greet(undefined, undefined, true);');

    const user = parseTypeScript(TEXT, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.title === 'Set user');
    expect(
      apply(TEXT, {
        type: 'connect',
        from: { node: user?.id ?? '', pin: 'out' },
        to: { node: node.id, pin: 'param:person' },
      })
    ).toContain('greet(user);');
  });

  it('types given arguments and adds pins after them', () => {
    const text = TEXT.replace('greet();', 'greet(user);');
    const pins = callNode(text, 'greet').pins.filter(
      (p) => p.direction === 'in' && p.kind === 'data'
    );
    expect(pins.map((p) => `${p.id}:${p.type}`)).toEqual([
      'arg0:string',
      'param:times:number',
      'param:loud:bool',
    ]);
    expect(
      apply(text, {
        type: 'setLiteral',
        node: callNode(text, 'greet').id,
        pin: 'param:times',
        value: '3',
      })
    ).toContain('greet(user, 3);');
  });

  it('completes method calls through this', () => {
    const text = 'class A {\n  add(n: number) {}\n  run() { this.add(); }\n}\n';
    const node = parseTypeScript(text, 't.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.kind === 'call');
    expect(
      node?.pins.some((p) => p.id === 'param:n' && p.type === 'number')
    ).toBe(true);
  });

  it('adds argument pins to calls of unknown functions', () => {
    const text = 'console.log("a");\n';
    expect(
      apply(text, {
        type: 'addArgument',
        node: callNode(text, 'console.log').id,
      })
    ).toBe('console.log("a", undefined);\n');
    expect(
      apply('run();\n', {
        type: 'addArgument',
        node: callNode('run();\n', 'run').id,
      })
    ).toBe('run(undefined);\n');
  });

  it('removes argument pins with their comma', () => {
    expect(removeArg('f(a, b, c);\n', 'f', 'arg1')).toBe('f(a, c);\n');
    expect(removeArg('f(a, b);\n', 'f', 'arg1')).toBe('f(a);\n');
    expect(removeArg('f(a);\n', 'f', 'arg0')).toBe('f();\n');
    expect(removeArg('f(a, ...rest);\n', 'f', 'arg1')).toBe('f(a);\n');
  });

  it('knows the default value of given arguments', () => {
    const text = TEXT.replace('greet();', 'greet(user, 5);');
    const pin = callNode(text, 'greet').pins.find((p) => p.id === 'arg1');
    expect(pin?.meta).toMatchObject({ defaultValue: '2' });
  });
});
