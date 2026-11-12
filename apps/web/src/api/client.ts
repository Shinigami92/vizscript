import type {
  BranchSummary,
  FileResponse,
  LayoutResponse,
  LayoutUpdateRequest,
  MeResponse,
  PreferenceResponse,
  ProviderId,
  RecentProject,
  RecentProjectRequest,
  RepoSummary,
  TreeResponse,
} from '@vizscript/api-contract';

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = (await response.json()) as { message?: string | string[] };
      if (data.message) {
        message = Array.isArray(data.message)
          ? data.message.join(', ')
          : data.message;
      }
    } catch {
      // keep status text
    }

    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

const enc = encodeURIComponent;

function repoPath(provider: ProviderId, owner: string, repo: string): string {
  return `/scm/${provider}/repos/${enc(owner)}/${enc(repo)}`;
}

function layoutPath(
  provider: ProviderId,
  owner: string,
  repo: string,
  ref: string,
  path: string
): string {
  return `/layouts/${provider}/${enc(owner)}/${enc(repo)}?ref=${enc(ref)}&path=${enc(path)}`;
}

export const api = {
  me(): Promise<MeResponse> {
    return request('GET', '/auth/me');
  },
  loginWithToken(provider: ProviderId, token: string): Promise<MeResponse> {
    return request('POST', '/auth/token', { provider, token });
  },
  logout(): Promise<void> {
    return request('POST', '/auth/logout');
  },

  listRepos(
    provider: ProviderId,
    query = '',
    page = 1
  ): Promise<RepoSummary[]> {
    return request(
      'GET',
      `/scm/${provider}/repos?q=${enc(query)}&page=${page}`
    );
  },
  getRepo(
    provider: ProviderId,
    owner: string,
    repo: string
  ): Promise<RepoSummary> {
    return request('GET', repoPath(provider, owner, repo));
  },
  listBranches(
    provider: ProviderId,
    owner: string,
    repo: string
  ): Promise<BranchSummary[]> {
    return request('GET', `${repoPath(provider, owner, repo)}/branches`);
  },
  getTree(
    provider: ProviderId,
    owner: string,
    repo: string,
    ref: string
  ): Promise<TreeResponse> {
    return request(
      'GET',
      `${repoPath(provider, owner, repo)}/tree?ref=${enc(ref)}`
    );
  },
  getFile(
    provider: ProviderId,
    owner: string,
    repo: string,
    ref: string,
    path: string
  ): Promise<FileResponse> {
    return request(
      'GET',
      `${repoPath(provider, owner, repo)}/file?ref=${enc(ref)}&path=${enc(path)}`
    );
  },

  getLayout(
    provider: ProviderId,
    owner: string,
    repo: string,
    ref: string,
    path: string
  ): Promise<LayoutResponse> {
    return request('GET', layoutPath(provider, owner, repo, ref, path));
  },
  saveLayout(
    provider: ProviderId,
    owner: string,
    repo: string,
    ref: string,
    path: string,
    update: LayoutUpdateRequest
  ): Promise<LayoutResponse> {
    return request('PUT', layoutPath(provider, owner, repo, ref, path), update);
  },

  getPreference(key: string): Promise<PreferenceResponse> {
    return request('GET', `/preferences/${enc(key)}`);
  },
  savePreference(key: string, value: unknown): Promise<PreferenceResponse> {
    return request('PUT', `/preferences/${enc(key)}`, { value });
  },
  deletePreference(key: string): Promise<void> {
    return request('DELETE', `/preferences/${enc(key)}`);
  },

  listRecent(): Promise<RecentProject[]> {
    return request('GET', '/recent');
  },
  touchRecent(project: RecentProjectRequest): Promise<RecentProject[]> {
    return request('POST', '/recent', project);
  },
  removeRecent(
    provider: ProviderId,
    owner: string,
    repo: string
  ): Promise<void> {
    return request('DELETE', `/recent/${provider}/${enc(owner)}/${enc(repo)}`);
  },
};
