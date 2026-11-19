import { typescriptBackend } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import { callbackGroups } from '../src/graph/symbols';

const CODE = `load().then((data) => data);

export function table(rows: string[]): string[] {
  return rows
    .map((row) => row.trim())
    .filter((row) => {
      return [row].some((cell) => cell !== '');
    });
}

class Store {
  save(items: number[]): void {
    items.forEach((item) => console.log(item));
  }
}
`;

describe('callbacks in My Script', () => {
  const doc = typescriptBackend.parse(CODE, 'a.ts');

  it('are grouped by the function they are written in, nested', () => {
    const groups = callbackGroups(doc, CODE, doc.symbols ?? []);
    expect(
      groups.map((g) => ({
        owner: g.owner?.name ?? '(module)',
        rows: g.rows.map(
          (r) => `${'  '.repeat(r.depth)}${r.symbol.name}:${r.line}`
        ),
      }))
    ).toEqual([
      { owner: '(module)', rows: ['then callback:1'] },
      {
        owner: 'table',
        rows: ['rows.map callback:5', 'filter callback:6', '  some callback:7'],
      },
      { owner: 'save', rows: ['items.forEach callback:13'] },
    ]);
  });

  it('shows only the searched ones', () => {
    const shown = (doc.symbols ?? []).filter((s) => s.name.includes('map'));
    expect(callbackGroups(doc, CODE, shown).map((g) => g.owner?.name)).toEqual([
      'table',
    ]);
  });
});
