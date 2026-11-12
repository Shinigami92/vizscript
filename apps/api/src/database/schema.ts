import type { ColumnType, Generated, Selectable } from 'kysely';

type Timestamps = {
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
};

export interface UsersTable extends Timestamps {
  id: Generated<string>;
}

export interface IdentitiesTable extends Timestamps {
  id: Generated<string>;
  user_id: string;
  provider: string;
  provider_user_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface ScmCredentialsTable extends Timestamps {
  id: Generated<string>;
  user_id: string;
  provider: string;
  token_ciphertext: Buffer;
  token_iv: Buffer;
  token_tag: Buffer;
  scopes: string | null;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface RepositoriesTable extends Timestamps {
  id: Generated<string>;
  provider: string;
  external_id: string;
  full_name: string;
}

export type StoredPositions = Record<string, { x: number; y: number }>;

export interface FileLayoutsTable extends Timestamps {
  id: Generated<string>;
  repository_id: string;
  ref: string;
  path: string;
  positions: ColumnType<StoredPositions, string, string>;
  updated_by: string | null;
}

export interface UserPreferencesTable {
  user_id: string;
  key: string;
  value: ColumnType<unknown, string, string>;
  updated_at: Generated<Date>;
}

export interface RecentProjectsTable {
  user_id: string;
  provider: string;
  owner: string;
  repo: string;
  ref: string | null;
  path: string | null;
  opened_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  identities: IdentitiesTable;
  scm_credentials: ScmCredentialsTable;
  sessions: SessionsTable;
  repositories: RepositoriesTable;
  file_layouts: FileLayoutsTable;
  user_preferences: UserPreferencesTable;
  recent_projects: RecentProjectsTable;
}

export type Identity = Selectable<IdentitiesTable>;
