import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { parseGDScriptDocument } from '../src';

/**
 * Opt-in check against a real Godot project:
 * `GD_CORPUS=/path/to/project pnpm exec vitest run packages/lang-gdscript`.
 * Every `.gd` file must parse without diagnostics and lower without crashing.
 */
const root = process.env.GD_CORPUS ?? '';

function collect(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '.git' && name !== '.godot') {
        collect(path, out);
      }
    } else if (path.endsWith('.gd')) {
      out.push(path);
    }
  }

  return out;
}

it.skipIf(!root)('parses every script of GD_CORPUS', () => {
  const problems: string[] = [];
  for (const file of collect(root, [])) {
    const text = readFileSync(file, 'utf8');
    const doc = parseGDScriptDocument(text, file);
    for (const d of doc.diagnostics) {
      const line = text.slice(0, d.range.start).split('\n').length;
      problems.push(`${relative(root, file)}:${line} ${d.message}`);
    }
  }

  expect(problems).toEqual([]);
});
