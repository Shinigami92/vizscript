import { UnauthorizedException } from '@nestjs/common';
import type { ApiError, AuthErrorCode } from '@vizscript/api-contract';

/** A 401 that tells the client why (`ApiError.code`). */
export function authError(
  code: AuthErrorCode,
  message: string
): UnauthorizedException {
  const body: ApiError = { statusCode: 401, message, code };
  return new UnauthorizedException(body);
}
