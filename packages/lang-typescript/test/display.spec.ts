import { withImplicitSelf } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

describe('withImplicitSelf', () => {
  it('leaves TypeScript methods as they are (`this.save` is a path)', () => {
    const doc = parseTypeScript(
      'class Cart {\n  total(): void {\n    this.save();\n  }\n  save(): void {}\n}\n'
    );
    for (const fn of doc.functions) {
      expect(withImplicitSelf(fn)).toBe(fn);
    }
  });
});
