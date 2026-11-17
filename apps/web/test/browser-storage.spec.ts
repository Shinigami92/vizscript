import { describe, expect, it } from 'vitest';
import {
  pruneStored,
  readStored,
  STORAGE_VERSION,
  textVersion,
  writeStored,
} from '../src/storage/browser-storage';

/** `localStorage` for the tests; `limit` makes it run full. */
function memoryStorage(limit = Infinity): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      const size = [...data.entries()]
        .filter(([k]) => k !== key)
        .reduce((sum, [, v]) => sum + v.length, value.length);
      if (size > limit) {
        throw new Error('QuotaExceededError');
      }

      data.set(key, value);
    },
    removeItem: (key) => void data.delete(key),
  };
}

const DAY = 24 * 60 * 60 * 1000;
const isText = (data: unknown): string | null =>
  typeof data === 'string' ? data : null;

describe('browser storage', () => {
  it('reads its envelope and entries written before it', () => {
    const storage = memoryStorage();
    writeStored('vizscript:layout:a', 'new', storage);
    storage.setItem('vizscript:layout:b', JSON.stringify('old'));
    expect(readStored('vizscript:layout:a', isText, storage)).toBe('new');
    expect(readStored('vizscript:layout:b', isText, storage)).toBe('old');
  });

  it('leaves entries of a newer format alone', () => {
    const storage = memoryStorage();
    const raw = JSON.stringify({ v: STORAGE_VERSION + 1, at: 0, data: 'x' });
    storage.setItem('vizscript:layout:a', raw);
    expect(readStored('vizscript:layout:a', isText, storage)).toBeNull();
    expect(storage.getItem('vizscript:layout:a')).toBe(raw);
  });

  it('removes per-file entries not written for long, drafts last', () => {
    const storage = memoryStorage();
    const now = 400 * DAY;
    writeStored('vizscript:layout:old', 'x', storage, now - 200 * DAY);
    writeStored('vizscript:layout:new', 'x', storage, now - DAY);
    writeStored('vizscript:draft:a', 'x', storage, now - 60 * DAY);
    writeStored('vizscript:draft:b', 'x', storage, now - 100 * DAY);
    writeStored('vizscript:color', 'x', storage, 0);
    expect(pruneStored({ storage, now })).toBe(2);
    expect(storage.getItem('vizscript:layout:new')).not.toBeNull();
    expect(storage.getItem('vizscript:draft:a')).not.toBeNull();
    expect(storage.getItem('vizscript:color')).not.toBeNull();
  });

  it('makes room when the storage is full', () => {
    const storage = memoryStorage(220);
    const now = 100 * DAY;
    writeStored(
      'vizscript:camera:old',
      'x'.repeat(80),
      storage,
      now - 30 * DAY
    );
    expect(
      writeStored('vizscript:draft:a', 'y'.repeat(100), storage, now)
    ).toBe(true);
    expect(storage.getItem('vizscript:camera:old')).toBeNull();
  });

  it('gives texts a short version', () => {
    const text = 'x = 1\n'.repeat(1000);
    expect(textVersion(text)).toBe(textVersion(text));
    expect(textVersion(text)).not.toBe(textVersion(`${text} `));
    expect(textVersion(text).length).toBeLessThan(30);
  });
});
