import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Repositories a user opened, most recent first, with where they left off.
  pgm.createTable(
    'recent_projects',
    {
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users',
        onDelete: 'CASCADE',
      },
      provider: { type: 'text', notNull: true },
      owner: { type: 'text', notNull: true },
      repo: { type: 'text', notNull: true },
      ref: { type: 'text' },
      path: { type: 'text' },
      opened_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
    },
    { constraints: { primaryKey: ['user_id', 'provider', 'owner', 'repo'] } }
  );
  pgm.createIndex('recent_projects', [
    'user_id',
    { name: 'opened_at', sort: 'DESC' },
  ]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('recent_projects');
}
