export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  /** Secret used to derive the token encryption key. */
  appSecret: string;
  /** Mark cookies as `Secure` (enable behind HTTPS). */
  secureCookies: boolean;
  sessionTtlDays: number;
  runMigrations: boolean;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appSecret = required(env, 'APP_SECRET');
  if (appSecret.length < 32) {
    throw new Error('APP_SECRET must be at least 32 characters long');
  }

  return {
    port: Number(env.PORT ?? 3333),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: required(env, 'DATABASE_URL'),
    appSecret,
    secureCookies: env.SECURE_COOKIES === 'true',
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    runMigrations: env.RUN_MIGRATIONS !== 'false',
  };
}
