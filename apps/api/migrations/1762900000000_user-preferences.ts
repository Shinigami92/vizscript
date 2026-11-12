import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Per-user settings such as the workbench layout, stored as JSON by key.
  pgm.createTable(
    'user_preferences',
    {
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users',
        onDelete: 'CASCADE',
      },
      key: { type: 'text', notNull: true },
      value: { type: 'jsonb', notNull: true },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
    },
    { constraints: { primaryKey: ['user_id', 'key'] } }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('user_preferences');
}
