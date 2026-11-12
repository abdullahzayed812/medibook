import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { requirePermission, type AuthorizationService } from '../access/index.js';
import { requireAuth, type AccountService } from '../iam/index.js';

const params = z.object({ userId: z.string().regex(/^[1-9]\d{0,19}$/) });
const body = z.object({ reason: z.string().trim().min(3).max(255) });

/**
 * Platform administration (SUPER_ADMIN). Every route requires a platform permission, which in
 * turn requires an MFA-verified session (enforced centrally by AuthorizationService).
 */
export function createPlatformAdminRouter(deps: {
  authenticate: RequestHandler;
  authz: AuthorizationService;
  accounts: AccountService;
}): Router {
  const router = Router();
  const canManageStatus = requirePermission(deps.authz, 'platform.users.manage_status');

  router.post(
    '/admin/users/:userId/suspend',
    deps.authenticate,
    canManageStatus,
    validate({ params, body }),
    async (req, res) => {
      const auth = requireAuth(req);
      const { userId } = req.params as z.infer<typeof params>;
      const { reason } = req.body as z.infer<typeof body>;
      await deps.accounts.suspend(auth.userId, userId, reason, requestMeta(req));
      res.status(204).end();
    },
  );

  router.post(
    '/admin/users/:userId/reactivate',
    deps.authenticate,
    canManageStatus,
    validate({ params, body }),
    async (req, res) => {
      const auth = requireAuth(req);
      const { userId } = req.params as z.infer<typeof params>;
      const { reason } = req.body as z.infer<typeof body>;
      await deps.accounts.reactivate(auth.userId, userId, reason, requestMeta(req));
      res.status(204).end();
    },
  );

  return router;
}
