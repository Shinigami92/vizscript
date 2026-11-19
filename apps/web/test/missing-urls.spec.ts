import { describe, expect, it } from 'vitest';
import { MissingUrls } from '../src/graph/missing-urls';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('MissingUrls', () => {
  it('remembers 404s across visits: exact versions long, latest a day', () => {
    const storage = memoryStorage();
    const exact = 'https://cdn.jsdelivr.net/npm/ws@8.23.0/index.d.ts';
    const latest = 'https://cdn.jsdelivr.net/npm/@types/x@latest/package.json';
    const first = new MissingUrls(() => storage);
    first.add(exact, 0);
    first.add(latest, 0);

    // A new visit reads them back.
    const next = new MissingUrls(() => storage);
    expect(next.has(exact, DAY / 2)).toBe(true);
    expect(next.has(latest, DAY / 2)).toBe(true);
    expect(next.has(latest, 2 * DAY)).toBe(false);
    expect(next.has(exact, 2 * DAY)).toBe(true);
    expect(next.has(exact, 31 * DAY)).toBe(false);
    expect(next.has('https://example.test/other', 0)).toBe(false);
  });
});
