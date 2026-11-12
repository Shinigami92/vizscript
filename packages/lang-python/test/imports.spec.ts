import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

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
  it('collects Python imports', () => {
    const doc = parsePythonDocument(
      'import os.path\nimport numpy as np, sys\nfrom ..pkg.mod import a as b, c\nfrom . import utils\ntry:\n    import json\nexcept ImportError:\n    pass\n\ndef f():\n    import re\n',
      't.py'
    );
    expect(imports(doc)).toMatchInlineSnapshot(`
      [
        "os ← * of os.path",
        "np ← * of numpy",
        "sys ← * of sys",
        "b ← a of ..pkg.mod",
        "c ← c of ..pkg.mod",
        "utils ← utils of .",
        "json ← * of json",
      ]
    `);
  });
});

function del(text: string, name: string): string {
  const result = applyPythonOp(
    text,
    { type: 'deleteSymbol', symbol: `import:${name}` },
    't.py'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('deleting imports', () => {
  it('removes one name of a list', () => {
    expect(del('import numpy as np, sys\n', 'np')).toBe('import sys\n');
    expect(del('from x import (a, b)\n', 'b')).toBe('from x import (a)\n');
  });

  it('keeps a block valid', () => {
    expect(
      del('try:\n    import json\nexcept ImportError:\n    pass\n', 'json')
    ).toBe('try:\n    pass\nexcept ImportError:\n    pass\n');
  });
});
