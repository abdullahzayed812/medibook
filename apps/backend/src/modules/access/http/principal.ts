import type { Request } from 'express';
import { requireAuth } from '../../iam/index.js';
import type { Principal } from '../authorization/authorization.service.js';

/** The authenticated caller as an authorization principal. */
export function principalOf(req: Request): Principal {
  const auth = requireAuth(req);
  return { userId: auth.userId, mfaVerified: auth.mfaVerified };
}
