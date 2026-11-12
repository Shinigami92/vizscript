import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

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
  it('collects TypeScript imports', () => {
    const doc = parseTypeScript(
      "import a, { b as c, type D } from './x';\nimport * as ns from 'y';\nimport type { E } from './e';\n",
      't.ts'
    );
    expect(imports(doc)).toMatchInlineSnapshot(`
      [
        "a ← default of ./x",
        "c ← b of ./x",
        "D ← D of ./x [type]",
        "ns ← * of y",
        "E ← E of ./e [type]",
      ]
    `);
  });
});

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function del(text: string, name: string): string {
  return apply(text, { type: 'deleteSymbol', symbol: `import:${name}` });
}

describe('deleting imports', () => {
  it('removes one name of a list', () => {
    const text = "import { a, b, c } from './x';\nconsole.log(a);\n";
    expect(del(text, 'a')).toBe(
      "import { b, c } from './x';\nconsole.log(a);\n"
    );
    expect(del(text, 'c')).toBe(
      "import { a, b } from './x';\nconsole.log(a);\n"
    );
  });

  it('removes braces left empty', () => {
    expect(del("import a, { b } from './x';\n", 'b')).toBe(
      "import a from './x';\n"
    );
    expect(del("import a, { b } from './x';\n", 'a')).toBe(
      "import { b } from './x';\n"
    );
  });

  it('removes the statement with its last name', () => {
    expect(del("import { a } from './x';\n\nconst y = 1;\n", 'a')).toBe(
      'const y = 1;\n'
    );
  });
});
