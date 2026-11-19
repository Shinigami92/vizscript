import { useToasts } from '../composables/use-toasts';

/**
 * Per-file data kept in the browser (drafts, layouts, cameras, tabs), in a
 * versioned envelope with the time it was written: newer formats are left
 * alone by older apps, old entries can be cleaned up, and a full storage is
 * reported instead of failing silently.
 */

/** Format of the envelope; bump it when `data` of an entry changes shape. */
export const STORAGE_VERSION = 1;

interface Envelope {
  v: number;
  /** When it was written (ms since epoch). */
  at: number;
  data: unknown;
}

export type KeyValueStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

function browserStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Envelope).v === 'number' &&
    typeof (value as Envelope).at === 'number' &&
    'data' in value
  );
}

/**
 * Reads an entry: `parse` checks its data (also of entries written before
 * the envelope) and returns `null` for anything it doesn't accept. Entries
 * of a newer format are not touched.
 */
export function readStored<T>(
  key: string,
  parse: (data: unknown) => T | null,
  storage: KeyValueStorage | undefined = browserStorage()
): T | null {
  try {
    const raw = storage?.getItem(key);
    if (raw === null || raw === undefined) {
      return null;
    }

    const value = JSON.parse(raw) as unknown;
    if (isEnvelope(value)) {
      return value.v === STORAGE_VERSION ? parse(value.data) : null;
    }

    return parse(value);
  } catch {
    return null;
  }
}

let warnedFull = false;

/** Tells the user once per visit that the browser keeps nothing more. */
function reportFull(): void {
  if (!warnedFull) {
    warnedFull = true;
    useToasts().show(
      'The browser storage is full: unsaved changes and layouts may not be kept after a reload.',
      'error'
    );
  }
}

/**
 * Writes an entry. When the storage is full, old entries are cleaned up
 * and it is tried once more; if it still fails the user is told. Returns
 * whether it was written.
 */
export function writeStored(
  key: string,
  data: unknown,
  storage: KeyValueStorage | undefined = browserStorage(),
  now = Date.now()
): boolean {
  if (!storage) {
    return false;
  }

  const raw = JSON.stringify({ v: STORAGE_VERSION, at: now, data });
  try {
    storage.setItem(key, raw);
    return true;
  } catch {
    pruneStored({ storage, now, aggressive: true });
    try {
      storage.setItem(key, raw);
      return true;
    } catch {
      reportFull();
      return false;
    }
  }
}

export function removeStored(
  key: string,
  storage: KeyValueStorage | undefined = browserStorage()
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // storage unavailable
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** How long entries of each kind are kept after they were last written. */
const KEEP: ReadonlyArray<{ prefix: string; days: number }> = [
  { prefix: 'vizscript:draft:', days: 90 },
  { prefix: 'vizscript:draft-layout:', days: 90 },
  { prefix: 'vizscript:tree:', days: 90 },
  { prefix: 'vizscript:layout:', days: 180 },
  { prefix: 'vizscript:camera:', days: 60 },
  { prefix: 'vizscript:tabs:', days: 120 },
];

/** Entries holding unsaved work. */
const UNSAVED = new Set([
  'vizscript:draft:',
  'vizscript:draft-layout:',
  'vizscript:tree:',
]);

/**
 * Removes per-file entries not written for a long time (`aggressive`: a
 * tenth of that, to make room when the storage is full; drafts are kept).
 * Entries written before the envelope have no age and stay.
 */
export function pruneStored(
  options: {
    storage?: KeyValueStorage;
    now?: number;
    aggressive?: boolean;
  } = {}
): number {
  const storage = options.storage ?? browserStorage();
  const now = options.now ?? Date.now();
  if (!storage) {
    return 0;
  }

  const stale: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const kind = key ? KEEP.find((k) => key.startsWith(k.prefix)) : undefined;
      if (!key || !kind) {
        continue;
      }

      // Unsaved work stays, also when room is needed.
      if (options.aggressive && UNSAVED.has(kind.prefix)) {
        continue;
      }

      const days = options.aggressive ? kind.days / 10 : kind.days;
      const value = JSON.parse(storage.getItem(key) ?? 'null') as unknown;
      if (isEnvelope(value) && now - value.at > days * DAY) {
        stale.push(key);
      }
    }
  } catch {
    // unreadable entry or storage: keep what there is
  }

  for (const key of stale) {
    removeStored(key, storage);
  }

  return stale.length;
}

/**
 * A short version of a text (cyrb53): drafts of local files compare it
 * instead of keeping the whole file text twice.
 */
export function textVersion(text: string): string {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  const hash = 4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0);
  return `t:${text.length}:${hash.toString(36)}`;
}
