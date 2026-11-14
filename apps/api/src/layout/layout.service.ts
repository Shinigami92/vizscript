import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type {
  LayoutResponse,
  LayoutUpdateRequest,
  Point,
  ProviderId,
  RepoSummary,
} from '@vizscript/api-contract';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { SessionUser } from '../auth/auth.service';
import { DB } from '../database/database.module';
import type { Database } from '../database/schema';
import { RepoAccessService } from '../scm/repo-access.service';

export interface LayoutKey {
  provider: ProviderId;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

const MAX_POSITIONS = 20_000;

export function parseLayoutUpdate(body: unknown): {
  set: Record<string, Point>;
  remove: string[];
} {
  const positions = (body as Partial<LayoutUpdateRequest> | null)?.positions;
  if (!positions || typeof positions !== 'object' || Array.isArray(positions)) {
    throw new BadRequestException('positions must be an object');
  }

  const entries = Object.entries(positions);
  if (entries.length > MAX_POSITIONS) {
    throw new BadRequestException('Too many positions');
  }

  const set: Record<string, Point> = {};
  const remove: string[] = [];
  for (const [id, value] of entries) {
    if (id.length > 512) {
      throw new BadRequestException('Node id too long');
    }

    if (value === null) {
      remove.push(id);
      continue;
    }

    const { x, y } = value as Partial<Point>;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BadRequestException(`Invalid position for ${id}`);
    }

    set[id] = { x: Math.round(x as number), y: Math.round(y as number) };
  }

  return { set, remove };
}

/**
 * Shared node layouts of repository files. Everyone who can read a
 * repository sees them (signed-out visitors: public repositories); only users
 * with write access change them.
 */
@Injectable()
export class LayoutService {
  public constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(RepoAccessService) private readonly access: RepoAccessService
  ) {}

  /**
   * Internal repository id. Layouts are keyed by the provider's stable
   * repository id so they survive renames.
   */
  private async repositoryId(
    provider: ProviderId,
    repo: RepoSummary
  ): Promise<string> {
    const row = await this.db
      .insertInto('repositories')
      .values({
        provider,
        external_id: repo.id,
        full_name: repo.fullName,
      })
      .onConflict((oc) =>
        oc.columns(['provider', 'external_id']).doUpdateSet({
          full_name: repo.fullName,
          updated_at: new Date(),
        })
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  public async get(
    user: SessionUser | null,
    key: LayoutKey
  ): Promise<LayoutResponse> {
    const repo = await this.access.repo(
      user,
      key.provider,
      key.owner,
      key.repo
    );
    const repositoryId = await this.repositoryId(key.provider, repo);
    const row = await this.db
      .selectFrom('file_layouts')
      .select(['positions', 'updated_at'])
      .where('repository_id', '=', repositoryId)
      .where('ref', '=', key.ref)
      .where('path', '=', key.path)
      .executeTakeFirst();
    return {
      positions: row?.positions ?? {},
      updatedAt: row?.updated_at.toISOString() ?? null,
      canWrite: user !== null && repo.canWrite,
    };
  }

  public async update(
    user: SessionUser,
    key: LayoutKey,
    body: unknown
  ): Promise<LayoutResponse> {
    const { set, remove } = parseLayoutUpdate(body);
    const repo = await this.access.repo(
      user,
      key.provider,
      key.owner,
      key.repo
    );
    if (!repo.canWrite) {
      throw new ForbiddenException(
        'Changing the shared layout needs write access to the repository'
      );
    }

    const repositoryId = await this.repositoryId(key.provider, repo);
    const patch = JSON.stringify(set);
    const removeArray = sql`${sql.val(remove)}::text[]`;

    const row = await this.db
      .insertInto('file_layouts')
      .values({
        repository_id: repositoryId,
        ref: key.ref,
        path: key.path,
        positions: patch,
        updated_by: user.userId,
      })
      .onConflict((oc) =>
        oc.columns(['repository_id', 'ref', 'path']).doUpdateSet({
          positions: sql<string>`(file_layouts.positions || ${patch}::jsonb) - ${removeArray}`,
          updated_by: user.userId,
          updated_at: new Date(),
        })
      )
      .returning(['positions', 'updated_at'])
      .executeTakeFirstOrThrow();

    return {
      positions: row.positions,
      updatedAt: row.updated_at.toISOString(),
      canWrite: true,
    };
  }
}
