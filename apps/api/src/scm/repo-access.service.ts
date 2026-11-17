import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ProviderId, RepoSummary } from '@vizscript/api-contract';
import type { SessionUser } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import { ScmRegistry } from './scm.registry';

/** How long a checked access stays valid. */
const TTL_MS = 5 * 60 * 1000;
/** Whether a repository is public changes rarely: signed-out checks last. */
const PUBLIC_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * Checks what a user (or a signed-out visitor) may do with a repository by
 * asking the provider with their token. Signed-out checks use the server's
 * token if one is set (`GITHUB_SERVER_TOKEN`, a higher limit), else none
 * (public repositories only, the server's own hourly limit). Results are
 * cached, refusals too, so layout requests don't cost a provider request
 * each.
 */
@Injectable()
export class RepoAccessService {
  private readonly cache = new Map<
    string,
    { repo?: RepoSummary; error?: unknown; expires: number }
  >();

  public constructor(
    @Inject(ScmRegistry) private readonly registry: ScmRegistry,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
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
      if (cached.repo) {
        return cached.repo;
      }

      throw cached.error;
    }

    let summary: RepoSummary;
    try {
      summary = user
        ? await this.registry
            .get(provider)
            .getRepo(
              await this.auth.providerToken(user.userId, provider),
              owner,
              repo
            )
        : await this.signedOut(provider, owner, repo);
    } catch (error) {
      // "No access" and "not found" are remembered briefly; a rejected
      // token or a failing provider are not (a new token or retry works).
      if (
        error instanceof HttpException &&
        (error.getStatus() === 403 || error.getStatus() === 404)
      ) {
        this.remember(key, { error, expires: now + TTL_MS });
      }

      throw error;
    }

    this.remember(key, {
      repo: summary,
      expires: now + (user ? TTL_MS : PUBLIC_TTL_MS),
    });
    return summary;
  }

  /**
   * A repository as a signed-out visitor sees it: public only. With the
   * server's token, a private repository it can read must still not show.
   */
  private async signedOut(
    provider: ProviderId,
    owner: string,
    repo: string
  ): Promise<RepoSummary> {
    const summary = await this.registry
      .get(provider)
      .getRepo(this.config.githubServerToken ?? null, owner, repo);
    if (summary.private) {
      throw new NotFoundException('Not found');
    }

    return { ...summary, canWrite: false };
  }

  private remember(
    key: string,
    entry: { repo?: RepoSummary; error?: unknown; expires: number }
  ): void {
    const now = Date.now();
    if (this.cache.size >= MAX_ENTRIES) {
      for (const [k, cached] of this.cache) {
        if (cached.expires <= now || this.cache.size >= MAX_ENTRIES) {
          this.cache.delete(k);
        }
      }
    }

    this.cache.set(key, entry);
  }
}
