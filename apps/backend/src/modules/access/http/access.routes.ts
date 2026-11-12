import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Database } from '../../../infrastructure/database/database.js';
import type { Clock } from '../../../shared/security/clock.js';
import { validate } from '../../../shared/http/middleware/validate.js';
import { requestMeta } from '../../../shared/http/request-meta.js';
import { SECURITY_EVENT, type SecurityEventLog } from '../../audit/index.js';
import { requireAuth, type SessionService } from '../../iam/index.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import {
  clinicContext,
  requireTenant,
  type TenantContextResolver,
} from '../tenancy/tenant-context.js';

export interface AccessRouteDeps {
  readonly db: Database;
  readonly authenticate: RequestHandler;
  readonly authz: AuthorizationService;
  readonly resolver: TenantContextResolver;
  readonly memberships: MembershipsRepository;
  readonly sessions: SessionService;
  readonly securityEvents: SecurityEventLog;
  readonly globalRoles: (userId: string) => Promise<string[]>;
  readonly clock: Clock;
}

export function createAccessRouter(deps: AccessRouteDeps): Router {
  const router = Router();
  const { authenticate, authz } = deps;
  const optionalClinic = clinicContext(deps.resolver, { required: false });
  const requiredClinic = clinicContext(deps.resolver);

  /** Global roles and clinic roles, reported separately. Clinic roles only from active memberships. */
  router.get('/me/roles', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    const active = await deps.memberships.listActiveForUser(deps.db, auth.userId, deps.clock());
    const clinics = new Map<string, { clinicId: string; clinicName: string; roles: string[] }>();
    for (const m of active) {
      const entry = clinics.get(m.clinicId) ?? {
        clinicId: m.clinicId,
        clinicName: m.clinicName,
        roles: [],
      };
      entry.roles.push(m.role);
      clinics.set(m.clinicId, entry);
    }
    res.json({
      data: { global: await deps.globalRoles(auth.userId), clinics: [...clinics.values()] },
    });
  });

  /** All memberships with status and history-relevant dates (including inactive ones). */
  router.get('/me/memberships', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    res.json({ data: await deps.memberships.listForUser(deps.db, auth.userId) });
  });

  /**
   * Effective permissions: platform + patient from global roles; clinic permissions only for the
   * validated clinic/branch context of this request (X-Clinic-Id / X-Branch-Id), if any.
   */
  router.get('/me/permissions', authenticate, optionalClinic, async (req, res) => {
    const auth = requireAuth(req);
    const platform = await authz.globalPermissions(auth.userId, 'PLATFORM');
    res.json({
      data: {
        platform: {
          permissions: platform,
          mfaSatisfied: platform.length === 0 || auth.mfaVerified,
        },
        patient: await authz.globalPermissions(auth.userId, 'PATIENT'),
        clinic:
          req.tenant === undefined
            ? null
            : {
                clinicId: req.tenant.clinicId,
                branchId: req.tenant.branchId,
                roles: [...new Set(req.tenant.memberships.map((m) => m.role))],
                permissions: await authz.clinicPermissions(req.tenant),
              },
      },
    });
  });

  // --- Clinic context ---
  router.get('/context/clinics', authenticate, async (req, res) => {
    const auth = requireAuth(req);
    const active = await deps.memberships.listActiveForUser(deps.db, auth.userId, deps.clock());
    const clinics = new Map<
      string,
      { id: string; name: string; roles: string[]; current: boolean }
    >();
    for (const m of active) {
      const entry = clinics.get(m.clinicId) ?? {
        id: m.clinicId,
        name: m.clinicName,
        roles: [],
        current: m.clinicId === auth.activeClinicId,
      };
      entry.roles.push(m.role);
      clinics.set(m.clinicId, entry);
    }
    res.json({ data: [...clinics.values()] });
  });

  /** Remembers a clinic on the session after verifying membership; `null` clears it. */
  router.post(
    '/context/clinic',
    authenticate,
    validate({
      body: z.object({
        clinicId: z
          .string()
          .regex(/^[1-9]\d{0,19}$/)
          .nullable(),
      }),
    }),
    async (req, res) => {
      const auth = requireAuth(req);
      const { clinicId } = req.body as { clinicId: string | null };
      if (clinicId !== null) await deps.resolver.resolve(auth.userId, clinicId, null);
      await deps.sessions.setActiveClinic(auth.sessionId, clinicId);
      await deps.securityEvents.record(
        deps.db,
        {
          type: SECURITY_EVENT.CLINIC_CONTEXT_SWITCHED,
          outcome: 'INFO',
          userId: auth.userId,
          sessionId: auth.sessionId,
          metadata: { clinicId },
        },
        requestMeta(req),
      );
      res.json({ data: { clinicId } });
    },
  );

  /** Branches the caller may act in within the selected clinic. */
  router.get('/context/branches', authenticate, requiredClinic, async (req, res) => {
    const tenant = requireTenant(req);
    const all = tenant.memberships.some((m) => m.branchScope === 'ALL');
    const assigned = [...new Set(tenant.memberships.flatMap((m) => m.branchIds))];
    res.json({
      data: await deps.memberships.listBranches(deps.db, tenant.clinicId, all ? 'ALL' : assigned),
    });
  });

  return router;
}
