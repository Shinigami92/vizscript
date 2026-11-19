import { join } from 'node:path';
import { runMigrations } from '../src/database/migrate';

/**
 * Migrates the test database once before the e2e files run (side by side,
 * they would take the migration lock at the same time).
 */
export default async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    await runMigrations(
      databaseUrl,
      join(import.meta.dirname, '..', 'migrations')
    );
  }
}
