import { withImplicitSelf } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

describe('withImplicitSelf', () => {
  it('shows `this` as a box on calls of the own methods', () => {
    const doc = parseTypeScript(
      'class Cart {\n  total(): void {\n    this.save();\n  }\n  save(): void {}\n}\n'
    );
    const fn = doc.functions.find((f) =>
      f.nodes.some((n) => n.kind === 'call' && n.title === 'save')
    );
    const shown = fn ? withImplicitSelf(fn) : undefined;
    expect(shown?.nodes.some((n) => n.kind === 'getVar')).toBe(false);
    expect(shown?.edges.filter((e) => e.kind === 'data')).toHaveLength(0);
    const save = shown?.nodes.find((n) => n.title === 'save');
    expect(save?.pins.find((p) => p.id === 'target')?.literal?.value).toBe(
      'this'
    );
  });
});
