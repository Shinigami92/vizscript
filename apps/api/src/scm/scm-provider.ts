import type {
  BranchSummary,
  FileResponse,
  ProviderId,
  RepoSummary,
  TreeResponse,
} from '@vizscript/api-contract';

export interface ProviderIdentity {
  providerUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  scopes: string | null;
}

/**
 * A source code host (GitHub today; GitLab or a local folder later).
 * All calls receive the user's provider token; `getRepo` also works without
 * one (`null`) for public repositories.
 */
export interface ScmProvider {
  readonly id: ProviderId;
  verifyToken(token: string): Promise<ProviderIdentity>;
  listRepos(
    token: string,
    options: { page: number; query?: string }
  ): Promise<RepoSummary[]>;
  getRepo(
    token: string | null,
    owner: string,
    repo: string
  ): Promise<RepoSummary>;
  listBranches(
    token: string,
    owner: string,
    repo: string
  ): Promise<BranchSummary[]>;
  getTree(
    token: string,
    owner: string,
    repo: string,
    ref: string
  ): Promise<TreeResponse>;
  getFile(
    token: string,
    owner: string,
    repo: string,
    ref: string,
    path: string
  ): Promise<FileResponse>;
}

export const SCM_PROVIDERS = Symbol('SCM_PROVIDERS');
