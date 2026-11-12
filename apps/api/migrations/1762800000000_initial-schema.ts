import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  const timestamps = {
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  } as const;
  const id = {
    type: 'uuid',
    primaryKey: true,
    default: pgm.func('gen_random_uuid()'),
  } as const;

  pgm.createTable('users', { id, ...timestamps });

  pgm.createTable(
    'identities',
    {
      id,
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users',
        onDelete: 'CASCADE',
      },
      provider: { type: 'text', notNull: true },
      provider_user_id: { type: 'text', notNull: true },
      login: { type: 'text', notNull: true },
      name: { type: 'text' },
      avatar_url: { type: 'text' },
      ...timestamps,
    },
    { constraints: { unique: [['provider', 'provider_user_id']] } }
  );
  pgm.createIndex('identities', 'user_id');

  pgm.createTable(
    'scm_credentials',
    {
      id,
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users',
        onDelete: 'CASCADE',
      },
      provider: { type: 'text', notNull: true },
      token_ciphertext: { type: 'bytea', notNull: true },
      token_iv: { type: 'bytea', notNull: true },
      token_tag: { type: 'bytea', notNull: true },
      scopes: { type: 'text' },
      ...timestamps,
    },
    { constraints: { unique: [['user_id', 'provider']] } }
  );

  pgm.createTable('sessions', {
    // SHA-256 of the session token; the token itself is never stored.
    id: { type: 'text', primaryKey: true },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: timestamps.created_at,
  });
  pgm.createIndex('sessions', 'user_id');
  pgm.createIndex('sessions', 'expires_at');

  pgm.createTable(
    'repositories',
    {
      id,
      provider: { type: 'text', notNull: true },
      external_id: { type: 'text', notNull: true },
      full_name: { type: 'text', notNull: true },
      ...timestamps,
    },
    { constraints: { unique: [['provider', 'external_id']] } }
  );
  pgm.createIndex('repositories', ['provider', 'full_name']);

  pgm.createTable(
    'file_layouts',
    {
      id,
      repository_id: {
        type: 'uuid',
        notNull: true,
        references: 'repositories',
        onDelete: 'CASCADE',
      },
      ref: { type: 'text', notNull: true },
      path: { type: 'text', notNull: true },
      positions: {
        type: 'jsonb',
        notNull: true,
        default: pgm.func(`'{}'::jsonb`),
      },
      updated_by: {
        type: 'uuid',
        references: 'users',
        onDelete: 'SET NULL',
      },
      ...timestamps,
    },
    { constraints: { unique: [['repository_id', 'ref', 'path']] } }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('file_layouts');
  pgm.dropTable('repositories');
  pgm.dropTable('sessions');
  pgm.dropTable('scm_credentials');
  pgm.dropTable('identities');
  pgm.dropTable('users');
}
