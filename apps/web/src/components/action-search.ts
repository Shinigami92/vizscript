import type { ActionEntry } from './ActionMenu.vue';

/** Words of a search, lowercased. */
export function searchTokens(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Letters and digits only: `Index Of…` → `indexof`. */
function joined(text: string): string {
  return text.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, '');
}

/**
 * How well an entry matches the search words, lower is better, or
 * `undefined` when a word is missing. Words match in any order, in the
 * label, category or keywords; written together they also match the
 * label's words (`indexof`, `lastindex`), like UE's palette search.
 */
export function searchScore(
  entry: Pick<ActionEntry, 'label' | 'category' | 'keywords'>,
  tokens: ReadonlyArray<string>
): number | undefined {
  const label = entry.label.toLowerCase();
  const compact = joined(entry.label);
  const haystack =
    `${label} ${entry.category} ${entry.keywords ?? ''}`.toLowerCase();
  const found = (token: string): boolean => {
    // `[` has no letters: it is looked for as it is.
    const word = joined(token);
    return haystack.includes(token) || (word !== '' && compact.includes(word));
  };
  if (!tokens.every(found)) {
    return undefined;
  }

  // The label starts with the words, then with them written together.
  const first = tokens[0] ?? '';
  const start = joined(tokens.join(''));
  if (label.startsWith(first)) {
    return 0;
  }

  if (start !== '' && compact.startsWith(start)) {
    return 0.5;
  }

  return label.includes(first) ? 1 : 2;
}
