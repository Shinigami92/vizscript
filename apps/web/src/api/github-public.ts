import type {
  BranchSummary,
  ClientConfig,
  FileResponse,
  RepoSummary,
  TreeResponse,
} from '@vizscript/api-contract';
import { shallowRef } from 'vue';
import { api, ApiError } from './client';

/**
 * Signed-out access to public GitHub repositories, straight from the browser
 * without a token. GitHub allows 60 API requests per hour per IP address for
 * this, so files are read from the raw host (not counted) and only the
 * repository, its tree and its branches use the API.
 */

const DEFAULT_CONFIG: ClientConfig['github'] = {
  apiUrl: 'https://api.github.com',
  rawUrl: 'https://raw.githubusercontent.com',
};

let config: Promise<ClientConfig['github']> | null = null;

function githubConfig(): Promise<ClientConfig['github']> {
  config ??= api
    .config()
    .then((c) => c.github)
    .catch(() => DEFAULT_CONFIG);
  return config;
}

/** GitHub's rate limit for signed-out requests, as of the last response. */
export const githubLimit = shallowRef<{
  remaining: number;
  limit: number;
  /** Epoch milliseconds when the limit resets. */
  reset: number;
} | null>(null);

function trackLimit(response: Response): void {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const limit = response.headers.get('x-ratelimit-limit');
  const reset = response.headers.get('x-ratelimit-reset');
  if (remaining !== null && limit !== null && reset !== null) {
    githubLimit.value = {
      remaining: Number(remaining),
      limit: Number(limit),
      reset: Number(reset) * 1000,
    };
  }
}

/**
 * Asks GitHub for the current limit of this IP address. The request itself
 * doesn't count, and it sees requests of other tabs too.
 */
export async function refreshGithubLimit(): Promise<void> {
  try {
    const { apiUrl } = await githubConfig();
    const response = await fetch(`${apiUrl}/rate_limit`, {
      headers: { accept: 'application/vnd.github+json' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as {
      resources?: {
        core?: { limit: number; remaining: number; reset: number };
      };
    };
    const core = data.resources?.core;
    if (core) {
      githubLimit.value = {
        remaining: core.remaining,
        limit: core.limit,
        reset: core.reset * 1000,
      };
    }
  } catch {
    // keep the last known value
  }
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

async function failure(response: Response): Promise<ApiError> {
  if (
    (response.status === 403 || response.status === 429) &&
    response.headers.get('x-ratelimit-remaining') === '0'
  ) {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const when = reset ? ` at ${timeFormat.format(reset)}` : ' later';
    return new ApiError(
      429,
      `GitHub's limit for signed-out use is reached. Sign in, or try again${when}.`
    );
  }

  if (response.status === 404) {
    return new ApiError(
      404,
      'Not found on GitHub. Private repositories need you to sign in.'
    );
  }

  let message = response.statusText || `GitHub answered ${response.status}`;
  try {
    const data = (await response.json()) as { message?: string };
    message = data.message ?? message;
  } catch {
    // keep the status text
  }

  return new ApiError(response.status, message);
}

const enc = encodeURIComponent;

async function getJson<T>(path: string): Promise<T> {
  const { apiUrl } = await githubConfig();
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { accept: 'application/vnd.github+json' },
    credentials: 'omit',
  });
  trackLimit(response);
  if (!response.ok) {
    throw await failure(response);
  }

  return (await response.json()) as T;
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${enc(owner)}/${enc(repo)}`;
}

/** Git's id of a file's content: SHA-1 of `blob <size>\0<bytes>`. */
async function blobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const data = new Uint8Array(header.byteLength + bytes.byteLength);
  data.set(header);
  data.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll('\n', '')), (c) =>
    c.charCodeAt(0)
  );
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch?: string;
  updated_at?: string | null;
}

export const githubPublic = {
  async getRepo(owner: string, repo: string): Promise<RepoSummary> {
    const data = await getJson<GitHubRepo>(repoPath(owner, repo));
    return {
      id: String(data.id),
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      description: data.description,
      private: data.private,
      defaultBranch: data.default_branch ?? 'main',
      updatedAt: data.updated_at ?? null,
      canWrite: false,
    };
  },

  async listBranches(owner: string, repo: string): Promise<BranchSummary[]> {
    const data = await getJson<Array<{ name: string }>>(
      `${repoPath(owner, repo)}/branches?per_page=100`
    );
    return data.map((b) => ({ name: b.name }));
  },

  async getTree(
    owner: string,
    repo: string,
    ref: string
  ): Promise<TreeResponse> {
    const data = await getJson<{
      truncated: boolean;
      tree: Array<{ path?: string; type?: string; size?: number }>;
    }>(`${repoPath(owner, repo)}/git/trees/${enc(ref)}?recursive=1`);
    return {
      ref,
      truncated: data.truncated,
      entries: data.tree
        .filter((e) => e.path && (e.type === 'blob' || e.type === 'tree'))
        .map((e) => ({
          path: e.path ?? '',
          type: e.type === 'tree' ? ('dir' as const) : ('file' as const),
          ...(e.size === undefined ? {} : { size: e.size }),
        })),
    };
  },

  /**
   * A file from the raw host, which doesn't count against the API limit.
   * Falls back to the contents API when the raw host can't be reached.
   */
  async getFile(
    owner: string,
    repo: string,
    ref: string,
    path: string
  ): Promise<FileResponse> {
    const { rawUrl } = await githubConfig();
    const filePath = path.split('/').map(enc).join('/');
    let bytes: Uint8Array | null = null;
    try {
      const response = await fetch(
        `${rawUrl}/${enc(owner)}/${enc(repo)}/${ref.split('/').map(enc).join('/')}/${filePath}`,
        { credentials: 'omit' }
      );
      if (response.status === 404) {
        throw await failure(response);
      }

      if (response.ok) {
        bytes = new Uint8Array(await response.arrayBuffer());
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      // network or CORS error: try the API below
    }

    if (!bytes) {
      const data = await getJson<{
        type: string;
        encoding?: string;
        content?: string;
        sha: string;
      }>(`${repoPath(owner, repo)}/contents/${filePath}?ref=${enc(ref)}`);
      if (data.type !== 'file') {
        throw new ApiError(404, 'Path is not a file');
      }

      bytes =
        data.encoding === 'base64' && data.content
          ? base64Bytes(data.content)
          : base64Bytes(
              (
                await getJson<{ content: string }>(
                  `${repoPath(owner, repo)}/git/blobs/${data.sha}`
                )
              ).content
            );
    }

    return {
      path,
      ref,
      sha: await blobSha(bytes),
      // Keep a BOM, like the API does.
      content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
    };
  },
};
