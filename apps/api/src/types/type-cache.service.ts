import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { TypeCacheStats } from '@vizscript/api-contract';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { promisify } from 'node:util';
import { zstdDecompress as zstdDecompressCallback } from 'node:zlib';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import { DB } from '../database/database.module';
import type { Database } from '../database/schema';
import { rustdocStubs } from './rustdoc';
import type { TypeSource } from './type-sources';

export interface CachedType {
  status: 200 | 404;
  body: string;
  immutable: boolean;
}

/** A file larger than this is not served (declaration files are smaller). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** A crate's compressed rustdoc JSON, and the JSON itself, at most. */
const MAX_RUSTDOC_BYTES = 32 * 1024 * 1024;
const MAX_RUSTDOC_JSON_BYTES = 256 * 1024 * 1024;
/** zstd frames start with these bytes. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const zstdDecompress = promisify(zstdDecompressCallback);
/** Upstream requests give up after this long. */
const FETCH_TIMEOUT_MS = 15_000;
/** A version range (`latest`, `^3.5.0`) is resolved again after a day. */
const RANGE_TTL_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often per row. */
const TOUCH_EVERY_MS = 60 * 60 * 1000;
/** Eviction runs at most this often. */
const EVICT_EVERY_MS = 30_000;
/**
 * Upstream fetches (cache misses) per client IP and window: a cold load of
 * one TypeScript file can need 800 files, and a team behind one address
 * shares the limit; it only stops the server being used as a proxy.
 */
export const MISS_LIMIT = 5000;
const MISS_WINDOW_MS = 10 * 60 * 1000;

/**
 * The type registry's cache: library type files and listings fetched once
 * from jsDelivr and kept in Postgres (`type_cache`) for every user. Exact
 * versions are kept until evicted, ranges for a day; 404s are remembered
 * too. The least recently used rows go when the total passes
 * `TYPE_CACHE_MAX_BYTES`.
 */
@Injectable()
export class TypeCacheService {
  private readonly inFlight = new Map<string, Promise<CachedType>>();
  private readonly misses = new Map<string, { count: number; since: number }>();
  private lastEviction = 0;
  private hits = 0;
  private fetches = 0;

  public constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  /** The file or listing of `source`, from the cache or fetched. */
  public async get(source: TypeSource, client: string): Promise<CachedType> {
    const row = await this.db
      .selectFrom('type_cache')
      .select(['status', 'body', 'immutable', 'expires_at', 'last_used_at'])
      .where('key', '=', source.key)
      .executeTakeFirst();
    const now = Date.now();
    if (
      row &&
      (row.immutable || (row.expires_at && row.expires_at.getTime() > now))
    ) {
      this.hits++;
      if (now - row.last_used_at.getTime() > TOUCH_EVERY_MS) {
        void this.touch(source.key);
      }

      return {
        status: row.status === 404 ? 404 : 200,
        body: row.body,
        immutable: row.immutable,
      };
    }

    let pending = this.inFlight.get(source.key);
    if (!pending) {
      this.countMiss(client, now);
      pending = this.fetchAndStore(source).finally(() =>
        this.inFlight.delete(source.key)
      );
      this.inFlight.set(source.key, pending);
    }

    return pending;
  }

  /** How full the cache is, and how often it answered since the start. */
  public async stats(): Promise<TypeCacheStats> {
    const totals = await this.db
      .selectFrom('type_cache')
      .select((eb) => [
        eb.fn.countAll<string>().as('entries'),
        eb.fn.coalesce(eb.fn.sum<string>('size'), sql<string>`0`).as('bytes'),
      ])
      .executeTakeFirstOrThrow();
    const requests = this.hits + this.fetches;
    return {
      entries: Number(totals.entries),
      bytes: Number(totals.bytes),
      maxBytes: this.config.typeCacheMaxBytes,
      hits: this.hits,
      fetches: this.fetches,
      hitRate: requests === 0 ? null : this.hits / requests,
    };
  }

  /** Too many upstream fetches from one client: 429. */
  private countMiss(client: string, now: number): void {
    const entry = this.misses.get(client);
    if (!entry || now - entry.since > MISS_WINDOW_MS) {
      this.misses.set(client, { count: 1, since: now });
      if (this.misses.size > 10_000) {
        this.misses.clear();
      }

      return;
    }

    entry.count++;
    if (entry.count > MISS_LIMIT) {
      throw new HttpException(
        'Too many library files requested; try again later',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }

  private async fetchAndStore(source: TypeSource): Promise<CachedType> {
    this.fetches++;
    const fetched =
      source.kind === 'crate'
        ? await this.fetchCrate(source)
        : await this.fetchText(source);
    const size = Buffer.byteLength(fetched.body);
    const expires = fetched.immutable
      ? null
      : new Date(Date.now() + RANGE_TTL_MS);
    const row = {
      status: fetched.status,
      body: fetched.body,
      size,
      immutable: fetched.immutable,
      expires_at: expires,
    };
    await this.db
      .insertInto('type_cache')
      .values({ key: source.key, ...row })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          ...row,
          fetched_at: sql`now()`,
          last_used_at: sql`now()`,
        })
      )
      .execute();
    void this.evict();
    return fetched;
  }

  private async fetchText(source: TypeSource): Promise<CachedType> {
    const fetched = await this.fetchUpstream(source.url, MAX_FILE_BYTES);
    return {
      status: fetched.status,
      body: fetched.bytes.toString('utf8'),
      immutable: source.immutable,
    };
  }

  /**
   * A crate's rustdoc JSON from docs.rs (zstd), turned into Rust
   * declarations per module; the newest compatible version when the asked
   * one has none (built before docs.rs made rustdoc JSON).
   */
  private async fetchCrate(source: TypeSource): Promise<CachedType> {
    let fetched = await this.fetchUpstream(source.url, MAX_RUSTDOC_BYTES);
    let immutable = source.immutable;
    if (fetched.status === 404 && source.fallback) {
      fetched = await this.fetchUpstream(source.fallback, MAX_RUSTDOC_BYTES);
      immutable = false;
    }

    if (fetched.status === 404 || !source.crate) {
      return { status: 404, body: '', immutable };
    }

    let json: unknown;
    try {
      const zstd = fetched.bytes.subarray(0, 4).equals(ZSTD_MAGIC);
      const raw = zstd
        ? await zstdDecompress(fetched.bytes, {
            maxOutputLength: MAX_RUSTDOC_JSON_BYTES,
          })
        : fetched.bytes;
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadGatewayException("The crate's documentation is unreadable");
    }

    const version =
      (typeof (json as { crate_version?: unknown }).crate_version === 'string'
        ? (json as { crate_version: string }).crate_version
        : undefined) ?? source.crate.version;
    const stubs = rustdocStubs(json, source.crate.name, version);
    if (!stubs) {
      throw new BadGatewayException("The crate's documentation is unreadable");
    }

    return { status: 200, body: JSON.stringify(stubs), immutable };
  }

  private async fetchUpstream(
    url: string,
    limit: number
  ): Promise<{ status: 200 | 404; bytes: Buffer }> {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });
    } catch {
      throw new BadGatewayException('Library files are not reachable');
    }

    if (response.status === 404) {
      await response.body?.cancel();
      return { status: 404, bytes: Buffer.alloc(0) };
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new BadGatewayException(
        `Library files answered ${response.status}`
      );
    }

    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > limit) {
      await response.body?.cancel();
      throw new BadGatewayException('Library file too large');
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new BadGatewayException('Library file too large');
    }

    return { status: 200, bytes };
  }

  private async touch(key: string): Promise<void> {
    try {
      await this.db
        .updateTable('type_cache')
        .set({ last_used_at: sql`now()`, hits: sql`hits + 1` })
        .where('key', '=', key)
        .execute();
    } catch {
      // Only bookkeeping: the file was served.
    }
  }

  /** Drops the least recently used rows while the total is too large. */
  public async evict(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastEviction < EVICT_EVERY_MS) {
      return;
    }

    this.lastEviction = now;
    try {
      // Every row whose running total (newest first) passes the limit.
      await sql`
        delete from type_cache where key in (
          select key from (
            select key, sum(size) over (order by last_used_at desc, key) as total
            from type_cache
          ) ranked
          where total > ${this.config.typeCacheMaxBytes}
        )
      `.execute(this.db);
    } catch {
      // Tried again with the next fetch.
      this.lastEviction = 0;
    }
  }
}
