import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  BranchSummary,
  FileResponse,
  ProviderId,
  RepoSummary,
  TreeResponse,
} from '@vizscript/api-contract';
import type { SessionUser } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { ScmRegistry } from './scm.registry';

@Controller('scm/:provider')
@UseGuards(SessionGuard)
export class ScmController {
  public constructor(
    @Inject(ScmRegistry) private readonly registry: ScmRegistry,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  private async context(user: SessionUser, providerId: string) {
    const provider = this.registry.get(providerId);
    const token = await this.auth.providerToken(
      user.userId,
      providerId as ProviderId
    );
    return { provider, token };
  }

  @Get('repos')
  public async listRepos(
    @CurrentUser() user: SessionUser,
    @Param('provider') providerId: string,
    @Query('q') query?: string,
    @Query('page') page?: string
  ): Promise<RepoSummary[]> {
    const { provider, token } = await this.context(user, providerId);
    return provider.listRepos(token, {
      page: Math.max(1, Number(page) || 1),
      query,
    });
  }

  @Get('repos/:owner/:repo')
  public async getRepo(
    @CurrentUser() user: SessionUser,
    @Param('provider') providerId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string
  ): Promise<RepoSummary> {
    const { provider, token } = await this.context(user, providerId);
    return provider.getRepo(token, owner, repo);
  }

  @Get('repos/:owner/:repo/branches')
  public async listBranches(
    @CurrentUser() user: SessionUser,
    @Param('provider') providerId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string
  ): Promise<BranchSummary[]> {
    const { provider, token } = await this.context(user, providerId);
    return provider.listBranches(token, owner, repo);
  }

  @Get('repos/:owner/:repo/tree')
  public async getTree(
    @CurrentUser() user: SessionUser,
    @Param('provider') providerId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('ref') ref?: string
  ): Promise<TreeResponse> {
    if (!ref) {
      throw new BadRequestException('ref is required');
    }

    const { provider, token } = await this.context(user, providerId);
    return provider.getTree(token, owner, repo, ref);
  }

  @Get('repos/:owner/:repo/file')
  public async getFile(
    @CurrentUser() user: SessionUser,
    @Param('provider') providerId: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('ref') ref?: string,
    @Query('path') path?: string
  ): Promise<FileResponse> {
    if (!ref || !path) {
      throw new BadRequestException('ref and path are required');
    }

    const { provider, token } = await this.context(user, providerId);
    return provider.getFile(token, owner, repo, ref, path);
  }
}
