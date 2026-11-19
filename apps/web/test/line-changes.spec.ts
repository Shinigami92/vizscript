import { describe, expect, it } from 'vitest';
import { lineChanges } from '../src/graph/line-changes';

const BASE = ['a', 'b', 'c', 'd', 'e'].join('\n');

describe('changed lines against the saved text', () => {
  it('finds nothing in the same text', () => {
    expect(lineChanges(BASE, BASE)).toEqual([]);
  });

  it('marks added lines', () => {
    expect(
      lineChanges(BASE, ['a', 'b', 'x', 'y', 'c', 'd', 'e'].join('\n'))
    ).toEqual([{ kind: 'added', start: 3, end: 4 }]);
  });

  it('marks modified lines', () => {
    expect(lineChanges(BASE, ['a', 'B', 'c', 'd', 'E'].join('\n'))).toEqual([
      { kind: 'modified', start: 2, end: 2 },
      { kind: 'modified', start: 5, end: 5 },
    ]);
  });

  it('marks deleted lines at the line above', () => {
    expect(lineChanges(BASE, ['a', 'd', 'e'].join('\n'))).toEqual([
      { kind: 'deleted', start: 1, end: 1 },
    ]);
    expect(lineChanges(BASE, ['b', 'c', 'd', 'e'].join('\n'))).toEqual([
      { kind: 'deleted', start: 1, end: 1 },
    ]);
  });

  it('tells apart several changes', () => {
    expect(
      lineChanges(BASE, ['a', 'new', 'b', 'C', 'C2', 'e'].join('\n'))
    ).toEqual([
      { kind: 'added', start: 2, end: 2 },
      { kind: 'modified', start: 4, end: 5 },
    ]);
  });
});
