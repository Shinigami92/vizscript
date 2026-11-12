import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import type {
  BranchSummary,
  FileResponse,
  RepoSummary,
  TreeResponse,
} from '@vizscript/api-contract';
import type { ProviderIdentity, ScmProvider } from './scm-provider';

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

function toRepo(repo: GitHubRepo): RepoSummary {
  return {
    id: String(repo.id),
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    defaultBranch: repo.default_branch ?? 'main',
    updatedAt: repo.updated_at ?? null,
  };
}

/** Translates Octokit errors into HTTP exceptions. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message =
      (error as { message?: string }).message ?? 'GitHub request failed';
    if (status === 401) {
      throw new UnauthorizedException('GitHub rejected the token');
    }

    if (status === 404) {
      throw new NotFoundException('Not found on GitHub');
    }

    if (status === 403 || status === 429) {
      throw new ForbiddenException(message);
    }

    if (status) {
      throw new HttpException(message, HttpStatus.BAD_GATEWAY);
    }

    throw error;
  }
}

@Injectable()
export class GitHubProvider implements ScmProvider {
  public readonly id = 'github' as const;

  private client(token: string): Octokit {
    return new Octokit({ auth: token, userAgent: 'vizscript' });
  }

  public async verifyToken(token: string): Promise<ProviderIdentity> {
    const response = await call(() =>
      this.client(token).rest.users.getAuthenticated()
    );
    return {
      providerUserId: String(response.data.id),
      login: response.data.login,
      name: response.data.name ?? null,
      avatarUrl: response.data.avatar_url ?? null,
      scopes: response.headers['x-oauth-scopes'] ?? null,
    };
  }

  public async listRepos(
    token: string,
    options: { page: number; query?: string }
  ): Promise<RepoSummary[]> {
    const octokit = this.client(token);
    const query = options.query?.trim();
    if (query) {
      const response = await call(() =>
        octokit.rest.search.repos({
          q: query.includes('/') ? `repo:${query}` : query,
          per_page: 50,
          page: options.page,
        })
      );
      return response.data.items
        .filter(
          (r): r is typeof r & { owner: { login: string } } => r.owner !== null
        )
        .map((r) => toRepo(r));
    }

    const response = await call(() =>
      octokit.rest.repos.listForAuthenticatedUser({
        sort: 'updated',
        per_page: 100,
        page: options.page,
      })
    );
    return response.data.map((r) => toRepo(r));
  }

  public async getRepo(
    token: string,
    owner: string,
    repo: string
  ): Promise<RepoSummary> {
    const response = await call(() =>
      this.client(token).rest.repos.get({ owner, repo })
    );
    return toRepo(response.data);
  }

  public async listBranches(
    token: string,
    owner: string,
    repo: string
  ): Promise<BranchSummary[]> {
    const response = await call(() =>
      this.client(token).rest.repos.listBranches({ owner, repo, per_page: 100 })
    );
    return response.data.map((b) => ({ name: b.name }));
  }

  public async getTree(
    token: string,
    owner: string,
    repo: string,
    ref: string
  ): Promise<TreeResponse> {
    const response = await call(() =>
      this.client(token).rest.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: 'true',
      })
    );
    return {
      ref,
      truncated: response.data.truncated,
      entries: response.data.tree
        .filter((e) => e.path && (e.type === 'blob' || e.type === 'tree'))
        .map((e) => ({
          path: e.path,
          type: e.type === 'tree' ? ('dir' as const) : ('file' as const),
          ...(e.size === undefined ? {} : { size: e.size }),
        })),
    };
  }

  public async getFile(
    token: string,
    owner: string,
    repo: string,
    ref: string,
    path: string
  ): Promise<FileResponse> {
    const octokit = this.client(token);
    const response = await call(() =>
      octokit.rest.repos.getContent({ owner, repo, path, ref })
    );
    const data = response.data;
    if (Array.isArray(data) || data.type !== 'file') {
      throw new NotFoundException('Path is not a file');
    }

    let content: string;
    if (data.encoding === 'base64' && data.content) {
      content = Buffer.from(data.content, 'base64').toString('utf8');
    } else {
      // Files > 1 MB are not inlined by the contents API.
      const blob = await call(() =>
        octokit.rest.git.getBlob({ owner, repo, file_sha: data.sha })
      );
      content = Buffer.from(blob.data.content, 'base64').toString('utf8');
    }

    return { path, ref, sha: data.sha, content };
  }
}
