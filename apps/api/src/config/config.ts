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
  /** Web pages of GitHub (`https://github.com`, or the Enterprise host). */
  githubWebUrl: string;
  /**
   * Optional token of the server for signed-out access checks of public
   * repositories (a higher hourly limit than without one).
   */
  githubServerToken?: string;
  /** Size the type registry's cache may grow to, in bytes (1 GB default). */
  typeCacheMaxBytes: number;
  /** Where library types come from (jsDelivr, docs.rs; tests use a local server). */
  typeUpstream: { cdn: string; listing: string; docs: string };
}

/** 1 GB. */
export const DEFAULT_TYPE_CACHE_BYTES = 1024 * 1024 * 1024;

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

/** `https://api.github.com` → `https://github.com`; Enterprise: its host. */
function webUrlOf(apiUrl: string): string {
  return apiUrl === 'https://api.github.com'
    ? 'https://github.com'
    : apiUrl.replace(/\/api\/v3$/, '');
}

/** `1073741824`, `512MB`, `2GB` → bytes; the default when unset. */
export function byteSize(value: string | undefined): number {
  if (!value) {
    return DEFAULT_TYPE_CACHE_BYTES;
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
  if (!match?.[1]) {
    throw new Error(`TYPE_CACHE_MAX_BYTES is no size: ${value}`);
  }

  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    (match[2] ?? '').toLowerCase() as '' | 'k' | 'm' | 'g'
  ];
  return Math.round(Number(match[1]) * unit);
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
    githubWebUrl: withoutSlash(env.GITHUB_WEB_URL ?? webUrlOf(githubApiUrl)),
    ...(env.GITHUB_SERVER_TOKEN
      ? { githubServerToken: env.GITHUB_SERVER_TOKEN }
      : {}),
    typeCacheMaxBytes: byteSize(env.TYPE_CACHE_MAX_BYTES),
    typeUpstream: {
      cdn: `${withoutSlash(env.TYPE_CDN_URL ?? 'https://cdn.jsdelivr.net')}/`,
      listing: `${withoutSlash(
        env.TYPE_LISTING_URL ?? 'https://data.jsdelivr.com/v1/packages'
      )}/`,
      docs: `${withoutSlash(env.TYPE_DOCS_URL ?? 'https://docs.rs')}/`,
    },
  };
}
