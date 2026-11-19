import type { ImportedDeclaration, ScriptSymbol } from '@vizscript/core';
import { typescriptBackend } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import { globalObjects } from '../src/components/graph-canvas/graph-helpers';
import { isTypeImport } from '../src/graph/symbols';

const CODE = `import { Primitive, toText } from 'type-fest';
import type { Jsonify } from 'type-fest';

const value: Primitive = toText(1);
`;

const declaration = (
  name: string,
  kind: ScriptSymbol['kind']
): ScriptSymbol => ({
  id: name,
  name,
  kind,
  scope: '',
  modifiers: ['export'],
  dataType: 'any',
  range: { start: 0, end: 0 },
  nameRange: { start: 0, end: 0 },
});

const IMPORTS: ReadonlyArray<ImportedDeclaration> = [
  { name: 'Primitive', declaration: declaration('Primitive', 'type') },
  { name: 'toText', declaration: declaration('toText', 'function') },
];

describe('imports of types', () => {
  const doc = typescriptBackend.parse(CODE, 'a.ts', { imports: IMPORTS });
  const imports = (doc.symbols ?? []).filter((s) => s.kind === 'import');

  it('are told apart from imports of values', () => {
    expect(imports.map((s) => [s.name, isTypeImport(s)])).toEqual([
      ['Primitive', true],
      ['toText', false],
      ['Jsonify', true],
    ]);
  });

  it('are no objects to get', () => {
    expect(globalObjects(doc, null).map((g) => g.name)).not.toContain(
      'Primitive'
    );
  });
});
