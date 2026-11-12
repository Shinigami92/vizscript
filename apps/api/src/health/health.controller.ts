import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { DB } from '../database/database.module';
import type { Database } from '../database/schema';

@Controller('health')
export class HealthController {
  public constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  @Get()
  public async health(): Promise<{ status: 'ok' }> {
    try {
      await sql`select 1`.execute(this.db);
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }

    return { status: 'ok' };
  }
}
