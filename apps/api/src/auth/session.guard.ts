import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authError } from './auth-errors';
import type { SessionUser } from './auth.service';
import { AuthService, SESSION_COOKIE } from './auth.service';

type RequestWithUser = FastifyRequest & { user?: SessionUser };

@Injectable()
export class SessionGuard implements CanActivate {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = await sessionUser(this.auth, context);
    if (!user) {
      throw authError('not_signed_in', 'Not logged in');
    }

    request.user = user;
    return true;
  }
}

/**
 * The user of the request's session cookie. A cookie whose session is gone
 * (expired, logged out elsewhere) is cleared and answered with
 * `session_expired`, so the client can tell the user instead of quietly
 * acting signed out.
 */
async function sessionUser(
  auth: AuthService,
  context: ExecutionContext
): Promise<SessionUser | null> {
  const http = context.switchToHttp();
  const cookie = http.getRequest<RequestWithUser>().cookies[SESSION_COOKIE];
  if (!cookie) {
    return null;
  }

  const user = await auth.resolveSession(cookie);
  if (!user) {
    void http.getResponse<FastifyReply>().clearCookie(SESSION_COOKIE, {
      path: '/',
    });
    throw authError('session_expired', 'Your session has expired');
  }

  return user;
}

/**
 * Lets signed-out requests through; a valid session still sets the user
 * (read it with `OptionalUser`).
 */
@Injectable()
export class OptionalSessionGuard implements CanActivate {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = await sessionUser(this.auth, context);
    if (user) {
      request.user = user;
    }

    return true;
  }
}

export const OptionalUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser | null =>
    context.switchToHttp().getRequest<RequestWithUser>().user ?? null
);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      throw new UnauthorizedException();
    }

    return request.user;
  }
);
