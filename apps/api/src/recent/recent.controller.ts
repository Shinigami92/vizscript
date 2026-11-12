import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { RecentProject } from '@vizscript/api-contract';
import type { SessionUser } from '../auth/auth.service';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { RecentService } from './recent.service';

@Controller('recent')
@UseGuards(SessionGuard)
export class RecentController {
  public constructor(
    @Inject(RecentService) private readonly recent: RecentService
  ) {}

  @Get()
  public async list(
    @CurrentUser() user: SessionUser
  ): Promise<RecentProject[]> {
    return this.recent.list(user.userId);
  }

  @Post()
  @HttpCode(200)
  public async touch(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown
  ): Promise<RecentProject[]> {
    return this.recent.touch(user.userId, body);
  }

  @Delete(':provider/:owner/:repo')
  @HttpCode(204)
  public async remove(
    @CurrentUser() user: SessionUser,
    @Param('provider') provider: string,
    @Param('owner') owner: string,
    @Param('repo') repo: string
  ): Promise<void> {
    await this.recent.remove(user.userId, provider, owner, repo);
  }
}
