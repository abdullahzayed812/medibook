import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, UnauthorizedError } from '../../../shared/errors/app-error.js';
import type { Clock } from '../../../shared/security/clock.js';
import {
  SessionInvalidError,
  type AppType,
  type SessionService,
} from '../sessions/sessions.service.js';
import type { AccessTokenService } from '../tokens/access-tokens.js';

/** Identity of the caller, resolved fresh from MySQL for every request. */
export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly appType: AppType;
  readonly mfaVerified: boolean;
  readonly activeClinicId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate`. Request-scoped: never shared between requests. */
    auth?: AuthContext;
  }
}

/** Returns the auth context or throws 401 (use in handlers mounted behind `authenticate`). */
export function requireAuth(req: Request): AuthContext {
  if (req.auth === undefined) throw new UnauthorizedError();
  return req.auth;
}

/**
 * Authenticates `Authorization: Bearer <access token>`:
 *  1. verifies the JWT (signature, alg, typ, iss, aud, exp, required claims);
 *  2. loads the session and account from MySQL and rejects revoked/expired sessions and
 *     non-ACTIVE accounts, so logout, revocation and suspension apply immediately.
 */
export function authenticate(
  tokens: AccessTokenService,
  sessions: SessionService,
  clock: Clock,
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (match?.[1] === undefined) throw new UnauthorizedError();

    const claims = await tokens.verify(match[1]);
    const session = await sessions.loadForRequest(claims.sid);
    if (
      session?.userId !== claims.sub ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= clock().getTime()
    ) {
      throw new SessionInvalidError();
    }
    if (session.accountStatus !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active');
    }

    await sessions.touch(session);
    req.auth = {
      userId: session.userId,
      sessionId: session.sessionId,
      appType: session.appType,
      mfaVerified: session.mfaVerifiedAt !== null,
      activeClinicId: session.activeClinicId,
    };
    next();
  };
}
