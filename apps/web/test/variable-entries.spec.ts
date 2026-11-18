import { describe, expect, it } from 'vitest';
import { searchScore, searchTokens } from '../src/components/action-search';
import { variableReadEntries } from '../src/components/graph-canvas/variable-entries';

const entries = (
  reads: string[] = []
): ReturnType<typeof variableReadEntries> =>
  variableReadEntries(
    [{ name: 'where', type: 'number' }],
    [
      {
        expression: 'where',
        dataType: 'number',
        type: 'number',
        constant: false,
      },
      {
        expression: 'this.name',
        dataType: 'string',
        type: 'string',
        constant: false,
      },
    ],
    'number',
    (expression) => reads.push(expression)
  );

describe('Get entries for an input, like UE’s', () => {
  it('names them "Get <name>", near values first, each once', () => {
    expect(entries().map((e) => e.label)).toEqual([
      'Get where',
      'Get this.name',
    ]);
  });

  it('reads the variable and says whether it fits the pin', () => {
    const reads: string[] = [];
    const [where, name] = entries(reads);
    where?.action('');
    expect(reads).toEqual(['where']);
    expect([where?.fits, name?.fits]).toEqual([true, false]);
  });

  it('is found by "get where" and by the name alone', () => {
    const [where] = entries();
    const score = (text: string): number | undefined =>
      where ? searchScore(where, searchTokens(text)) : undefined;
    expect(score('get where')).toBe(0);
    expect(score('where')).toBe(1);
  });
});
