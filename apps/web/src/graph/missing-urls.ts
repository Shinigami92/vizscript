import type { KeyValueStorage } from '../storage/browser-storage';
import { readStored, writeStored } from '../storage/browser-storage';

/**
 * Library files that answered 404, remembered across visits so a reload
 * doesn't ask jsDelivr again (most packages ship no `index.d.ts`, and many
 * have no `@types` package). Files of an exact version or commit never
 * appear later; `latest` and ranges are asked again after a day.
 */
const KEY = 'vizscript:missing-urls';
const DAY = 24 * 60 * 60 * 1000;
const EXACT_DAYS = 30;
/** At most this many URLs; the ones to be asked again soonest go first. */
const LIMIT = 2000;

/** `pkg@1.2.3/…`, `pkg@1.2.3-beta.1/…` or `repo@<commit>/…`. */
function isExact(url: string): boolean {
  return /@(?:\d+\.\d+\.\d+[\w.+-]*|[0-9a-f]{40})(?:\/|\?|$)/.test(url);
}

function parse(data: unknown): Record<string, number> | null {
  return data && typeof data === 'object'
    ? (data as Record<string, number>)
    : null;
}

export class MissingUrls {
  private until: Map<string, number> | undefined;

  public constructor(
    private readonly storage?: () => KeyValueStorage | undefined
  ) {}

  private load(): Map<string, number> {
    this.until ??= new Map(
      Object.entries(readStored(KEY, parse, this.storage?.()) ?? {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    );
    return this.until;
  }

  /** Whether `url` answered 404 recently enough not to ask again. */
  public has(url: string, now = Date.now()): boolean {
    return (this.load().get(url) ?? 0) > now;
  }

  public add(url: string, now = Date.now()): void {
    const until = this.load();
    until.set(url, now + (isExact(url) ? EXACT_DAYS : 1) * DAY);
    const kept = [...until]
      .filter(([, time]) => time > now)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, LIMIT);
    this.until = new Map(kept);
    writeStored(KEY, Object.fromEntries(kept), this.storage?.(), now);
  }
}
