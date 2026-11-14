/**
 * Shared types between the web app and the API.
 * Keep this package free of runtime dependencies.
 */

/** Source code providers. More (gitlab, local) will follow. */
export type ProviderId = 'github';

export const PROVIDERS: ReadonlyArray<ProviderId> = ['github'];

export interface Point {
  x: number;
  y: number;
}

export interface MeResponse {
  id: string;
  provider: ProviderId;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface TokenLoginRequest {
  provider: ProviderId;
  token: string;
}

export interface RepoSummary {
  /** Provider specific repository id. */
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
  /** The requesting user may push (always `false` when signed out). */
  canWrite: boolean;
}

export interface BranchSummary {
  name: string;
}

export interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface TreeResponse {
  ref: string;
  truncated: boolean;
  entries: TreeEntry[];
}

export interface FileResponse {
  path: string;
  ref: string;
  sha: string;
  content: string;
}

export interface LayoutResponse {
  positions: Record<string, Point>;
  updatedAt: string | null;
  /**
   * The requesting user may change the shared layout (signed in with write
   * access to the repository).
   */
  canWrite: boolean;
}

export interface LayoutUpdateRequest {
  /** `null` removes a stored position. */
  positions: Record<string, Point | null>;
}

/** A per-user setting, e.g. `workbench.layout`. */
export interface PreferenceResponse {
  key: string;
  /** `null` when the user has not stored this preference. */
  value: unknown;
  updatedAt: string | null;
}

export interface PreferenceUpdateRequest {
  value: unknown;
}

/** A repository the user opened, and where they left off. */
export interface RecentProject {
  provider: ProviderId;
  owner: string;
  repo: string;
  /** Branch (or other ref) last open; `null` before a branch was chosen. */
  ref: string | null;
  /** File last open; `null` when only the repository was open. */
  path: string | null;
  openedAt: string;
}

export interface RecentProjectRequest {
  provider: ProviderId;
  owner: string;
  repo: string;
  ref?: string | null;
  path?: string | null;
}

/** Public settings of the deployment, readable without signing in. */
export interface ClientConfig {
  github: {
    /** REST API base URL (`https://api.github.com`, or GitHub Enterprise). */
    apiUrl: string;
    /**
     * Base URL of raw file contents (`https://raw.githubusercontent.com`):
     * `<rawUrl>/<owner>/<repo>/<ref>/<path>`.
     */
    rawUrl: string;
  };
}

export interface ApiError {
  statusCode: number;
  message: string;
}
