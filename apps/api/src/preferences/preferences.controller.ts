import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { PreferenceResponse } from '@vizscript/api-contract';
import type { SessionUser } from '../auth/auth.service';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { PreferencesService } from './preferences.service';

@Controller('preferences')
@UseGuards(SessionGuard)
export class PreferencesController {
  public constructor(
    @Inject(PreferencesService)
    private readonly preferences: PreferencesService
  ) {}

  @Get(':key')
  public async get(
    @CurrentUser() user: SessionUser,
    @Param('key') key: string
  ): Promise<PreferenceResponse> {
    return this.preferences.get(user.userId, key);
  }

  @Put(':key')
  public async set(
    @CurrentUser() user: SessionUser,
    @Param('key') key: string,
    @Body() body: unknown
  ): Promise<PreferenceResponse> {
    return this.preferences.set(user.userId, key, body);
  }

  @Delete(':key')
  @HttpCode(204)
  public async remove(
    @CurrentUser() user: SessionUser,
    @Param('key') key: string
  ): Promise<void> {
    await this.preferences.remove(user.userId, key);
  }
}
