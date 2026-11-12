import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { requireAuth } from '../../iam/index.js';
import type { Permission } from '../authorization/catalog.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';

/**
 * Route guard: `router.get(path, authenticate, clinicContext(r), requirePermission(authz, 'clinic.patients.view'), handler)`.
 * Clinic permissions without a resolved clinic context are refused (fail safe), even if a route
 * forgot `clinicContext`.
 */
export function requirePermission(
  authz: AuthorizationService,
  permission: Permission,
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const auth = requireAuth(req);
    await authz.assert({ userId: auth.userId, mfaVerified: auth.mfaVerified }, permission, {
      tenant: req.tenant,
    });
    next();
  };
}
