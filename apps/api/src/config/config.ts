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
  /** GitHub REST API (`https://api.github.com`, or a GitHub Enterprise URL). */
  githubApiUrl: string;
  /** Raw file contents of GitHub (`https://raw.githubusercontent.com`). */
  githubRawUrl: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

function withoutSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Raw contents live on their own host for github.com, and under `/raw` for
 * GitHub Enterprise (`https://ghe.example/api/v3` → `https://ghe.example/raw`).
 */
function rawUrlOf(apiUrl: string): string {
  if (apiUrl === 'https://api.github.com') {
    return 'https://raw.githubusercontent.com';
  }

  return `${apiUrl.replace(/\/api\/v3$/, '')}/raw`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appSecret = required(env, 'APP_SECRET');
  if (appSecret.length < 32) {
    throw new Error('APP_SECRET must be at least 32 characters long');
  }

  const githubApiUrl = withoutSlash(
    env.GITHUB_API_URL ?? 'https://api.github.com'
  );
  return {
    port: Number(env.PORT ?? 3333),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: required(env, 'DATABASE_URL'),
    appSecret,
    secureCookies: env.SECURE_COOKIES === 'true',
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 30),
    runMigrations: env.RUN_MIGRATIONS !== 'false',
    githubApiUrl,
    githubRawUrl: withoutSlash(env.GITHUB_RAW_URL ?? rawUrlOf(githubApiUrl)),
  };
}
