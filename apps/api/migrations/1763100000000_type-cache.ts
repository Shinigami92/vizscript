import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Library type files and listings fetched for the web app (npm through
  // jsDelivr, typeshed). Only copies of public files: it may be emptied
  // (TRUNCATE) at any time. Least recently used rows go first when the
  // total size passes TYPE_CACHE_MAX_BYTES.
  pgm.createTable('type_cache', {
    key: { type: 'text', primaryKey: true },
    /** 200, or 404 (a file that doesn't exist, remembered too). */
    status: { type: 'smallint', notNull: true },
    body: { type: 'text', notNull: true },
    size: { type: 'integer', notNull: true },
    /** An exact version or commit: never fetched again. */
    immutable: { type: 'boolean', notNull: true },
    /** When a version range (`latest`, `^3.5.0`) is resolved again. */
    expires_at: { type: 'timestamptz' },
    fetched_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_used_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    hits: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.createIndex('type_cache', 'last_used_at');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('type_cache');
}
