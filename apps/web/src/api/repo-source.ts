import type {
  BranchSummary,
  FileResponse,
  ProviderId,
  RepoSummary,
  TreeResponse,
} from '@vizscript/api-contract';
import { api } from './client';
import { githubPublic } from './github-public';

/** Reads a repository: through the API when signed in, else from GitHub. */
export interface RepoSource {
  getRepo(owner: string, repo: string): Promise<RepoSummary>;
  listBranches(owner: string, repo: string): Promise<BranchSummary[]>;
  getTree(owner: string, repo: string, ref: string): Promise<TreeResponse>;
  getFile(
    owner: string,
    repo: string,
    ref: string,
    path: string
  ): Promise<FileResponse>;
}

/**
 * Signed-in users read through the API with their token (private
 * repositories, the higher rate limit). Signed-out visitors read public
 * repositories straight from GitHub, so each one has their own rate limit.
 */
export function repoSource(
  provider: ProviderId,
  signedIn: boolean
): RepoSource {
  if (!signedIn) {
    return githubPublic;
  }

  return {
    getRepo: (owner, repo) => api.getRepo(provider, owner, repo),
    listBranches: (owner, repo) => api.listBranches(provider, owner, repo),
    getTree: (owner, repo, ref) => api.getTree(provider, owner, repo, ref),
    getFile: (owner, repo, ref, path) =>
      api.getFile(provider, owner, repo, ref, path),
  };
}
