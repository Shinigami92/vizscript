import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

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

describe('adding imports', () => {
  it('preloads a script below extends', () => {
    const text = 'extends Node\n\n\nfunc f() -> void:\n\tpass\n';
    const doc = parseGDScriptDocument(text, 'game/player.gd');
    const entry = doc.functions
      .find((f) => f.name === 'f')
      ?.nodes.find((n) => n.kind === 'entry');
    const result = applyGDScriptOp(
      text,
      {
        type: 'withImport',
        import: {
          path: 'game/scenes/bullet.gd',
          from: 'game/player.gd',
          name: 'Bullet',
          imported: '*',
          root: 'game',
        },
        op: {
          type: 'addNode',
          template: { type: 'call', callee: 'Bullet.new' },
          after: { node: entry?.id ?? '', pin: 'then' },
        },
      },
      'game/player.gd'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'extends Node\n\nconst Bullet = preload("res://scenes/bullet.gd")\n\n\nfunc f() -> void:\n\tBullet.new()\n'
    );
  });
});
