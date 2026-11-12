import { createApp } from './app';
import { loadConfig } from './config/config';
import { runMigrations } from './database/migrate';

const config = loadConfig();

if (config.runMigrations) {
  await runMigrations(config.databaseUrl);
}

const app = await createApp(config);
await app.listen(config.port, config.host);
console.log(`vizscript api listening on http://${config.host}:${config.port}`);
