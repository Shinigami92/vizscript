import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SessionUser } from './auth.service';
import { AuthService, SESSION_COOKIE } from './auth.service';

type RequestWithUser = FastifyRequest & { user?: SessionUser };

@Injectable()
export class SessionGuard implements CanActivate {
  public constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = await this.auth.resolveSession(
      request.cookies[SESSION_COOKIE]
    );
    if (!user) {
      throw new UnauthorizedException('Not logged in');
    }

    request.user = user;
    return true;
  }
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
    const user = await this.auth.resolveSession(
      request.cookies[SESSION_COOKIE]
    );
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
