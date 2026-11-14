import type { GraphDocument, GraphNode } from '@vizscript/core';
import {
  applyConversion,
  applyTextEdits,
  findConversion,
  isCompact,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript, typescriptBackend } from '../src';

function node(doc: GraphDocument, title: string): GraphNode {
  const found = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!found) {
    throw new Error(`no ${title}`);
  }

  return found;
}

const conversions = typescriptBackend.typeSystem?.conversions;

describe('conversions (UE autocast)', () => {
  it('finds a conversion only for types that do not fit', () => {
    expect(findConversion(conversions, 'number', 'string')?.template).toBe(
      'String($value)'
    );
    expect(findConversion(conversions, 'number', 'number')).toBeUndefined();
    expect(findConversion(conversions, 'object', 'number')).toBeUndefined();
  });

  it('wires a value through its conversion', () => {
    const text =
      "function greet(name: string): void {}\nconst count = 5;\ngreet('a');\n";
    const doc = parseTypeScript(text, 'a.ts');
    const count = node(doc, 'Set count');
    const greet = node(doc, 'greet');
    const result = applyTypeScriptOp(
      text,
      {
        type: 'connect',
        from: { node: count.id, pin: 'out' },
        to: { node: greet.id, pin: 'arg0' },
        convert: 'String($value)',
      },
      'a.ts'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'function greet(name: string): void {}\nconst count = 5;\ngreet(String(count));\n'
    );
  });

  it('draws a conversion call as a compact pure node', () => {
    const doc = parseTypeScript('log(String(count));\n', 'a.ts');
    const convert = node(doc, 'String');
    expect(convert.purity).toBe('pure');
    expect(isCompact(convert)).toBe(true);
    expect(convert.pins.find((p) => p.id === 'return')?.type).toBe('string');
    // Other calls and a conversion as a statement stay as they are.
    expect(node(parseTypeScript('String(a);\n', 'a.ts'), 'String').purity).toBe(
      'impure'
    );
    expect(
      node(parseTypeScript('log(String(a, b));\n', 'a.ts'), 'String').purity
    ).toBe('impure');
  });

  it('wraps an expression before a postfix conversion', () => {
    expect(applyConversion('$value.to_string()', 'a + b')).toBe(
      '(a + b).to_string()'
    );
    expect(applyConversion('$value.to_string()', 'total')).toBe(
      'total.to_string()'
    );
    expect(applyConversion('String($value)', 'a + b')).toBe('String(a + b)');
  });
});
