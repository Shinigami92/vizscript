import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { LayoutResponse, ProviderId } from '@vizscript/api-contract';
import type { SessionUser } from '../auth/auth.service';
import {
  CurrentUser,
  OptionalSessionGuard,
  OptionalUser,
  SessionGuard,
} from '../auth/session.guard';
import type { LayoutKey } from './layout.service';
import { LayoutService } from './layout.service';

function layoutKey(
  provider: string,
  owner: string,
  repo: string,
  ref: string | undefined,
  path: string | undefined
): LayoutKey {
  if (!ref || !path) {
    throw new BadRequestException('ref and path are required');
  }

  return { provider: provider as ProviderId, owner, repo, ref, path };
}

@Controller('layouts/:provider/:owner/:repo')
export class LayoutController {
  public constructor(
    @Inject(LayoutService) private readonly layouts: LayoutService
  ) {}

  @Get()
  @UseGuards(OptionalSessionGuard)
  public async get(
    @OptionalUser() user: SessionUser | null,
    @Param('provider') provider: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('ref') ref?: string,
    @Query('path') path?: string
  ): Promise<LayoutResponse> {
    return this.layouts.get(user, layoutKey(provider, owner, repo, ref, path));
  }

  @Put()
  @UseGuards(SessionGuard)
  public async update(
    @CurrentUser() user: SessionUser,
    @Param('provider') provider: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Body() body: unknown,
    @Query('ref') ref?: string,
    @Query('path') path?: string
  ): Promise<LayoutResponse> {
    return this.layouts.update(
      user,
      layoutKey(provider, owner, repo, ref, path),
      body
    );
  }
}
