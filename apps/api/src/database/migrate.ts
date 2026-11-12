import { runner } from 'node-pg-migrate';
import { join } from 'node:path';

/**
 * Applies pending migrations. In the built app the migrations are bundled
 * next to `main.mjs` in `dist/migrations`.
 */
export async function runMigrations(
  databaseUrl: string,
  dir = join(import.meta.dirname, 'migrations')
): Promise<void> {
  await runner({
    databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    singleTransaction: true,
    ignorePattern: String.raw`.*\.map`,
    log: (message) => console.log(`[migrate] ${message}`),
  });
}
