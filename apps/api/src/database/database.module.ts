import type { OnApplicationShutdown } from '@nestjs/common';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import type { Database } from './schema';

export const DB = Symbol('DB');

export function createDatabase(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl, max: 10 }),
    }),
  });
}

@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  public constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDatabase(config.databaseUrl),
    },
    DatabaseShutdown,
  ],
  exports: [DB],
})
export class DatabaseModule {}
