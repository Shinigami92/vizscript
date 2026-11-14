import { Inject, Injectable } from '@nestjs/common';
import type { ProviderId, RepoSummary } from '@vizscript/api-contract';
import type { SessionUser } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';
import { ScmRegistry } from './scm.registry';

/** How long a checked access stays valid. */
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Checks what a user (or a signed-out visitor) may do with a repository by
 * asking the provider with their token (or none: public repositories only).
 * Results are cached for a few minutes, so layout requests don't cost a
 * provider request each.
 */
@Injectable()
export class RepoAccessService {
  private readonly cache = new Map<
    string,
    { repo: RepoSummary; expires: number }
  >();

  public constructor(
    @Inject(ScmRegistry) private readonly registry: ScmRegistry,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  /** The repository as the user sees it; throws when they can't read it. */
  public async repo(
    user: SessionUser | null,
    provider: ProviderId,
    owner: string,
    repo: string
  ): Promise<RepoSummary> {
    const key =
      `${user?.userId ?? '-'}:${provider}:${owner}/${repo}`.toLowerCase();
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) {
      return cached.repo;
    }

    const token = user
      ? await this.auth.providerToken(user.userId, provider)
      : null;
    const summary = await this.registry
      .get(provider)
      .getRepo(token, owner, repo);
    if (this.cache.size >= MAX_ENTRIES) {
      for (const [k, entry] of this.cache) {
        if (entry.expires <= now || this.cache.size >= MAX_ENTRIES) {
          this.cache.delete(k);
        }
      }
    }

    this.cache.set(key, { repo: summary, expires: now + TTL_MS });
    return summary;
  }
}
