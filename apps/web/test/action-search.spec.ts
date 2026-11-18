import { describe, expect, it } from 'vitest';
import { searchScore, searchTokens } from '../src/components/action-search';

const INDEX_OF = {
  label: 'Index Of',
  category: 'Array',
  keywords: 'index of index of indexOf array',
};
const LAST_INDEX = { label: 'Last Index', category: 'Array' };
const GET = {
  label: 'Get',
  category: 'Array',
  keywords: 'get index element item array list [ ]',
};

const score = (
  entry: Parameters<typeof searchScore>[0],
  text: string
): number | undefined => searchScore(entry, searchTokens(text));

describe('the action menu search', () => {
  it('finds words in any order, and written together', () => {
    expect(score(INDEX_OF, 'index of')).toBe(0);
    expect(score(INDEX_OF, 'of index')).toBe(1);
    // Written together: after labels that start with the words as typed.
    expect(score(INDEX_OF, 'indexof')).toBe(0.5);
    expect(score(INDEX_OF, 'IndexOf')).toBe(0.5);
    // Joined words of the label, with no keyword for them.
    expect(score(LAST_INDEX, 'lastindex')).toBe(0.5);
    expect(score({ label: '.indexOf()', category: '' }, 'index of')).toBe(0.5);
    expect(score(LAST_INDEX, 'last ind')).toBe(0);
  });

  it('needs every word', () => {
    expect(score(INDEX_OF, 'index off')).toBeUndefined();
    expect(score(LAST_INDEX, 'first index')).toBeUndefined();
  });

  it('looks for signs as they are', () => {
    expect(score(GET, '[')).toBe(2);
    expect(score(LAST_INDEX, '[')).toBeUndefined();
  });
});
