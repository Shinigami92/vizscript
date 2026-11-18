import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, pinLabel, spreadableWith } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function nodeOf(text: string, kind: GraphNode['kind']): GraphNode {
  const found = parseTypeScript(text, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === kind);
  if (!found) {
    throw new Error(`no ${kind} node`);
  }

  return found;
}

function spread(
  text: string,
  kind: GraphNode['kind'],
  pin: string,
  on: boolean
): string {
  const node = nodeOf(text, kind);
  const op: GraphOp = {
    type: 'setSpread',
    pin: { node: node.id, pin },
    spread: on,
  };
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('spread values', () => {
  it('spreads an argument and passes it as one value again', () => {
    const text =
      "function f(items: string[], more: string[]) {\n  items.push('abc', more);\n}\n";
    const spread1 = spread(text, 'call', 'arg1', true);
    expect(spread1).toContain("items.push('abc', ...more);");
    expect(spread(spread1, 'call', 'arg1', false)).toBe(text);
  });

  it('spreads an element of an array', () => {
    const text = 'const all = [a, b];\n';
    expect(spread(text, 'makeArray', 'e1', true)).toBe(
      'const all = [a, ...b];\n'
    );
    expect(spread('const all = [a, ... b];\n', 'makeArray', 'e1', false)).toBe(
      'const all = [a, b];\n'
    );
  });

  it('names a spread pin with its token', () => {
    const node = nodeOf('const all = [a, ...b];\n', 'makeArray');
    const pin = node.pins.find((p) => p.id === 'e1');
    expect(pin && pinLabel(node, pin)).toBe('...');
  });

  it('names a spread into a rest parameter like its other values', () => {
    const node = nodeOf(
      'function add(...data: number[]) {}\nfunction f(more: number[]) {\n  add(1, ...more);\n}\n',
      'call'
    );
    expect(
      node.pins
        .filter((p) => p.id.startsWith('arg'))
        .map((p) => pinLabel(node, p))
    ).toEqual(['data[0]', '...data[1]']);
  });

  it("doesn't spread an object's property", () => {
    const node = nodeOf('const o = { ...base, a: 1 };\n', 'makeObject');
    expect(node.pins.map((p) => spreadableWith(p))).not.toContain('...');
  });
});
