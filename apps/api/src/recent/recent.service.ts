import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  ProviderId,
  RecentProject,
  RecentProjectRequest,
} from '@vizscript/api-contract';
import { PROVIDERS } from '@vizscript/api-contract';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { DB } from '../database/database.module';
import type { Database } from '../database/schema';

/** How many repositories a user's list keeps. */
export const RECENT_LIMIT = 20;

const NAME = /^[\w.-]{1,100}$/;

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string' || value.length > max) {
    throw new BadRequestException('Invalid value');
  }

  return value;
}

export function parseRecentRequest(body: unknown): RecentProjectRequest {
  const input = (body ?? {}) as Partial<
    Record<keyof RecentProjectRequest, unknown>
  >;
  if (!PROVIDERS.includes(input.provider as ProviderId)) {
    throw new BadRequestException('Unknown provider');
  }

  if (
    typeof input.owner !== 'string' ||
    typeof input.repo !== 'string' ||
    !NAME.test(input.owner) ||
    !NAME.test(input.repo)
  ) {
    throw new BadRequestException('Invalid repository');
  }

  return {
    provider: input.provider as ProviderId,
    owner: input.owner,
    repo: input.repo,
    ref: text(input.ref, 255),
    path: text(input.path, 1024),
  };
}

@Injectable()
export class RecentService {
  public constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  public async list(userId: string): Promise<RecentProject[]> {
    const rows = await this.db
      .selectFrom('recent_projects')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('opened_at', 'desc')
      .limit(RECENT_LIMIT)
      .execute();
    return rows.map((row) => ({
      provider: row.provider as ProviderId,
      owner: row.owner,
      repo: row.repo,
      ref: row.ref,
      path: row.path,
      openedAt: row.opened_at.toISOString(),
    }));
  }

  /** Moves a repository to the top of the list (remembering ref and file). */
  public async touch(userId: string, body: unknown): Promise<RecentProject[]> {
    const project = parseRecentRequest(body);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('recent_projects')
        .values({
          user_id: userId,
          provider: project.provider,
          owner: project.owner,
          repo: project.repo,
          ref: project.ref ?? null,
          path: project.path ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['user_id', 'provider', 'owner', 'repo']).doUpdateSet({
            ref: sql<
              string | null
            >`coalesce(excluded.ref, recent_projects.ref)`,
            // A new file wins; the repository root of the same branch keeps
            // the last file; another branch forgets it.
            path: sql<string | null>`case
              when excluded.path is not null then excluded.path
              when excluded.ref is distinct from recent_projects.ref
                and excluded.ref is not null then null
              else recent_projects.path end`,
            opened_at: new Date(),
          })
        )
        .execute();

      // Only the newest entries are kept.
      await trx
        .deleteFrom('recent_projects')
        .where('user_id', '=', userId)
        .where((eb) =>
          eb(
            'opened_at',
            '<',
            eb
              .selectFrom('recent_projects')
              .select('opened_at')
              .where('user_id', '=', userId)
              .orderBy('opened_at', 'desc')
              .offset(RECENT_LIMIT - 1)
              .limit(1)
          )
        )
        .execute();
    });
    return this.list(userId);
  }

  public async remove(
    userId: string,
    provider: string,
    owner: string,
    repo: string
  ): Promise<void> {
    await this.db
      .deleteFrom('recent_projects')
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .where('owner', '=', owner)
      .where('repo', '=', repo)
      .execute();
  }
}
