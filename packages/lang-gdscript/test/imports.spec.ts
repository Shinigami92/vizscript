import { describe, expect, it } from 'vitest';
import { parseGDScriptDocument } from '../src';

function imports(doc: {
  symbols?: ReadonlyArray<{
    kind: string;
    name: string;
    module?: string;
    imported?: string;
    modifiers: string[];
  }>;
}): string[] {
  return (doc.symbols ?? [])
    .filter((s) => s.kind === 'import')
    .map(
      (s) =>
        `${s.name} ← ${s.imported} of ${s.module}${s.modifiers.length > 0 ? ` [${s.modifiers.join(' ')}]` : ''}`
    );
}

describe('import symbols', () => {
  it('collects GDScript preloads', () => {
    const doc = parseGDScriptDocument(
      'extends Node\n\nconst Bullet = preload("res://bullet.gd")\nconst SPEED = 3\n',
      't.gd'
    );
    expect(imports(doc)).toMatchInlineSnapshot(`
      [
        "Bullet ← * of res://bullet.gd [preload]",
      ]
    `);
  });
});
