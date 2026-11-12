import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PreferenceResponse } from '@vizscript/api-contract';
import type { Kysely } from 'kysely';
import { DB } from '../database/database.module';
import type { Database } from '../database/schema';

const KEY_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const MAX_VALUE_BYTES = 32 * 1024;

export function assertPreferenceKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new BadRequestException('Invalid preference key');
  }
}

/** Validates an update body and returns the serialized value. */
export function parsePreferenceUpdate(body: unknown): string {
  if (
    !body ||
    typeof body !== 'object' ||
    !('value' in body) ||
    body.value === undefined ||
    body.value === null
  ) {
    throw new BadRequestException('value is required');
  }

  const serialized = JSON.stringify(body.value);
  if (Buffer.byteLength(serialized) > MAX_VALUE_BYTES) {
    throw new BadRequestException('Preference value too large');
  }

  return serialized;
}

@Injectable()
export class PreferencesService {
  public constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  public async get(userId: string, key: string): Promise<PreferenceResponse> {
    assertPreferenceKey(key);
    const row = await this.db
      .selectFrom('user_preferences')
      .select(['value', 'updated_at'])
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .executeTakeFirst();
    return {
      key,
      value: row?.value ?? null,
      updatedAt: row?.updated_at.toISOString() ?? null,
    };
  }

  public async set(
    userId: string,
    key: string,
    body: unknown
  ): Promise<PreferenceResponse> {
    assertPreferenceKey(key);
    const value = parsePreferenceUpdate(body);
    const row = await this.db
      .insertInto('user_preferences')
      .values({ user_id: userId, key, value })
      .onConflict((oc) =>
        oc.columns(['user_id', 'key']).doUpdateSet({
          value,
          updated_at: new Date(),
        })
      )
      .returning(['value', 'updated_at'])
      .executeTakeFirstOrThrow();
    return { key, value: row.value, updatedAt: row.updated_at.toISOString() };
  }

  public async remove(userId: string, key: string): Promise<void> {
    assertPreferenceKey(key);
    await this.db
      .deleteFrom('user_preferences')
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .execute();
  }
}
