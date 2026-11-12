import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { parsePythonDocument } from '../src';

/**
 * Opt-in check against a real code base:
 * `PY_CORPUS=/path/to/project pnpm exec vitest run packages/lang-python`.
 * Every `.py` file must parse without diagnostics and lower without crashing.
 */
const root = process.env.PY_CORPUS ?? '';

function collect(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!name.startsWith('.') && name !== 'node_modules') {
        collect(path, out);
      }
    } else if (path.endsWith('.py')) {
      out.push(path);
    }
  }

  return out;
}

it.skipIf(!root)('parses every script of PY_CORPUS', () => {
  const problems: string[] = [];
  for (const file of collect(root, [])) {
    const text = readFileSync(file, 'utf8');
    const doc = parsePythonDocument(text, file);
    for (const d of doc.diagnostics) {
      const line = text.slice(0, d.range.start).split('\n').length;
      problems.push(`${relative(root, file)}:${line} ${d.message}`);
    }

    for (const fn of doc.functions) {
      for (const node of fn.nodes) {
        if (node.kind === 'unknown' && node.subtitle === 'Syntax error') {
          problems.push(`${relative(root, file)} ${node.title}`);
        }
      }
    }
  }

  expect(problems).toEqual([]);
});
