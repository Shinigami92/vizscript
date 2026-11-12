import { findNodeAtOffset } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';
import { summarize } from './summarize';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('parseTypeScript', () => {
  it.each(['greeter.ts', 'control-flow.ts', 'exports.ts'])(
    'lowers %s',
    (name) => {
      const doc = parseTypeScript(fixture(name), name);
      expect(summarize(doc)).toMatchSnapshot();
    }
  );

  it('shows exports as nodes of the module', () => {
    const doc = parseTypeScript(fixture('exports.ts'), 'exports.ts');
    const module = doc.functions[0];
    const exports = module?.nodes.filter((n) => n.kind === 'export') ?? [];
    expect(exports.map((n) => [n.title, n.subtitle ?? ''])).toEqual([
      ['Export', ''],
      ['Re-export', 'parse from ./parser'],
      ['Export * from', './types'],
      ['Export default', ''],
    ]);
    // `export default defineConfig(…)` keeps the call and wires its result.
    const exportDefault = exports.at(-1);
    const call = module?.nodes.find((n) => n.title === 'defineConfig');
    expect(
      module?.edges.some(
        (e) => e.from.node === call?.id && e.to.node === exportDefault?.id
      )
    ).toBe(true);
    expect(
      doc.functions.find((f) => f.name === 'twice')?.nodes[0]?.subtitle
    ).toBe('export function');
  });

  it('creates one graph per function', () => {
    const doc = parseTypeScript(fixture('control-flow.ts'), 'control-flow.ts');
    expect(doc.functions.map((f) => f.name)).toEqual([
      'Module',
      'loadUsers',
      'Counter.increment',
      'users.map callback',
    ]);
  });

  it('wires parameters directly from the entry node', () => {
    const doc = parseTypeScript(fixture('greeter.ts'), 'greeter.ts');
    const greeter = doc.functions.find((f) => f.name === 'greeter');
    const entry = greeter?.nodes.find((n) => n.kind === 'entry');
    expect(
      greeter?.edges.some(
        (e) =>
          e.kind === 'data' &&
          e.from.node === entry?.id &&
          e.from.pin === 'param0'
      )
    ).toBe(true);
  });

  it('keeps node ids stable when unrelated code changes', () => {
    const source = fixture('greeter.ts');
    const before = parseTypeScript(source, 'greeter.ts');
    const after = parseTypeScript(`// a comment\n\n${source}`, 'greeter.ts');
    const ids = (doc: typeof before): string[] =>
      doc.functions.flatMap((f) => f.nodes.map((n) => n.id));
    expect(ids(after)).toEqual(ids(before));
  });

  it('finds the innermost node at an offset', () => {
    const source = fixture('greeter.ts');
    const doc = parseTypeScript(source, 'greeter.ts');
    const node = findNodeAtOffset(doc, source.indexOf('person;'));
    expect(node?.kind).toBe('operator');
  });

  it('reports syntax errors as diagnostics', () => {
    const doc = parseTypeScript('const = ;', 'broken.ts');
    expect(doc.diagnostics.length).toBeGreaterThan(0);
  });
});
