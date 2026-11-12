import { describe, expect, it } from 'vitest';
import { pythonReferences } from '../src';

describe('pythonReferences', () => {
  it('finds relative and absolute imports', () => {
    const text = [
      'import os.path as p, helpers',
      'from ..pkg.mod import (a,',
      '    b as c)',
      'from . import utils',
      'try:',
      '    from .fast import speedup',
      'except ImportError:',
      '    pass',
    ].join('\n');
    const references = pythonReferences(text).filter(
      (r) => r.symbol === undefined && !/^\s/.test(r.specifier)
    );
    for (const r of references) {
      expect(text.slice(r.range.start, r.range.end)).toBe(r.specifier);
    }

    expect(references.map((r) => [r.specifier, r.candidates[0]])).toEqual([
      ['os.path', './os/path.py'],
      ['helpers', './helpers.py'],
      ['..pkg.mod', './../pkg/mod.py'],
      ['a', './../pkg/mod/a.py'],
      ['b', './../pkg/mod/b.py'],
      ['utils', './utils.py'],
      ['.fast', './fast.py'],
      ['speedup', './fast/speedup.py'],
    ]);
    // Absolute imports also resolve from the repository root.
    expect(references[1]?.candidates).toContain('/helpers.py');
    expect(references[2]?.candidates).not.toContain('/pkg/mod.py');
  });

  it('points uses of imported names at their definitions', () => {
    const text = [
      'from .helpers import load as read_file, VERSION',
      'import tools.db as db',
      '',
      'def main():',
      '    data = read_file("x")',
      '    db.save(data, VERSION)',
    ].join('\n');
    const uses = pythonReferences(text)
      .filter((r) => r.range.start > text.indexOf('def main'))
      .map((r) => [r.specifier, r.symbol, r.candidates[0]]);
    expect(uses).toEqual([
      ['read_file', 'load', './helpers/load.py'],
      ['db', undefined, './tools/db.py'],
      ['save', 'save', './tools/db.py'],
      ['VERSION', 'VERSION', './helpers/VERSION.py'],
    ]);
  });
});
