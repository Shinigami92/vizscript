import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { MeResponse, TokenLoginRequest } from '@vizscript/api-contract';
import { PROVIDERS } from '@vizscript/api-contract';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import type { SessionUser } from './auth.service';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { CurrentUser, SessionGuard } from './session.guard';

function parseLogin(body: unknown): TokenLoginRequest {
  const { provider, token } = (body ?? {}) as Partial<TokenLoginRequest>;
  if (!provider || !PROVIDERS.includes(provider)) {
    throw new BadRequestException('Unknown provider');
  }

  if (typeof token !== 'string' || token.trim().length < 10) {
    throw new BadRequestException('A token is required');
  }

  return { provider, token: token.trim() };
}

@Controller('auth')
export class AuthController {
  public constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  @Post('token')
  @HttpCode(200)
  public async loginWithToken(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<MeResponse> {
    const { provider, token } = parseLogin(body);
    const { sessionToken, expiresAt } = await this.auth.loginWithToken(
      provider,
      token
    );
    reply.setCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: '/',
      expires: expiresAt,
    });
    const session = await this.auth.resolveSession(sessionToken);
    if (!session) {
      throw new Error('Session was not created');
    }

    return this.auth.me(session.userId);
  }

  @Get('me')
  @UseGuards(SessionGuard)
  public async me(@CurrentUser() user: SessionUser): Promise<MeResponse> {
    return this.auth.me(user.userId);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  public async logout(
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<void> {
    await this.auth.logout(user.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
