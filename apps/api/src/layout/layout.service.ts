import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  LayoutResponse,
  LayoutUpdateRequest,
  Point,
  ProviderId,
} from '@vizscript/api-contract';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { AuthService } from '../auth/auth.service';
import { DB } from '../database/database.module';
import type { Database } from '../database/schema';
import { ScmRegistry } from '../scm/scm.registry';

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

@Injectable()
export class LayoutService {
  public constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(ScmRegistry) private readonly registry: ScmRegistry,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  /**
   * Resolves the internal repository id. Layouts are keyed by the provider's
   * stable repository id so they survive renames.
   */
  private async repositoryId(userId: string, key: LayoutKey): Promise<string> {
    const fullName = `${key.owner}/${key.repo}`;
    const cached = await this.db
      .selectFrom('repositories')
      .select('id')
      .where('provider', '=', key.provider)
      .where(sql`lower(full_name)`, '=', fullName.toLowerCase())
      .executeTakeFirst();
    if (cached) {
      return cached.id;
    }

    const token = await this.auth.providerToken(userId, key.provider);
    const repo = await this.registry
      .get(key.provider)
      .getRepo(token, key.owner, key.repo);
    const row = await this.db
      .insertInto('repositories')
      .values({
        provider: key.provider,
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

  public async get(userId: string, key: LayoutKey): Promise<LayoutResponse> {
    const repositoryId = await this.repositoryId(userId, key);
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
    };
  }

  public async update(
    userId: string,
    key: LayoutKey,
    body: unknown
  ): Promise<LayoutResponse> {
    const { set, remove } = parseLayoutUpdate(body);
    const repositoryId = await this.repositoryId(userId, key);
    const patch = JSON.stringify(set);
    const removeArray = sql`${sql.val(remove)}::text[]`;

    const row = await this.db
      .insertInto('file_layouts')
      .values({
        repository_id: repositoryId,
        ref: key.ref,
        path: key.path,
        positions: patch,
        updated_by: userId,
      })
      .onConflict((oc) =>
        oc.columns(['repository_id', 'ref', 'path']).doUpdateSet({
          positions: sql<string>`(file_layouts.positions || ${patch}::jsonb) - ${removeArray}`,
          updated_by: userId,
          updated_at: new Date(),
        })
      )
      .returning(['positions', 'updated_at'])
      .executeTakeFirstOrThrow();

    return {
      positions: row.positions,
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
