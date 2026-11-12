import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import {
  body,
  noteBody,
  pageQuery,
  params,
  query,
  reasonBody,
} from '../../shared/http/route-helpers.js';
import { principalOf, requireTenant } from '../access/index.js';
import { idSchema } from '../platform/index.js';
import type { ClinicService } from './clinic.service.js';
import { CLOSURE_STATUSES, type ClinicLifecycleService } from './lifecycle.service.js';
import { OPERATIONAL_STATUSES } from './operation-policy.js';
import type { ClinicPlatformService } from './platform.service.js';
import {
  accessExceptionSchema,
  branchCreateSchema,
  branchPatchSchema,
  clinicProfilePatchSchema,
  closureRequestSchema,
  suspensionSchema,
} from './schemas.js';

const p = (shape: z.ZodRawShape): RequestHandler => validate({ params: z.object(shape) });

export function createClinicsRouter(deps: {
  authenticate: RequestHandler;
  clinicContext: RequestHandler;
  clinics: ClinicService;
  lifecycle: ClinicLifecycleService;
  platform: ClinicPlatformService;
}): Router {
  const r = Router();
  const { authenticate: auth, clinicContext: ctx, clinics, lifecycle, platform } = deps;
  const branchParams = p({ branchId: idSchema });
  const closureParams = p({ id: idSchema });
  const actionParams = p({ id: idSchema, actionId: idSchema });
  const clinicParams = p({ clinicId: idSchema });

  // ---------- clinic side (X-Clinic-Id) ----------
  r.get('/clinic', auth, ctx, async (req, res) => {
    res.json({ data: await clinics.profile(principalOf(req), requireTenant(req)) });
  });
  r.patch('/clinic', auth, ctx, validate({ body: clinicProfilePatchSchema }), async (req, res) => {
    res.json({
      data: await clinics.updateProfile(
        principalOf(req),
        requireTenant(req),
        body(req),
        requestMeta(req),
      ),
    });
  });
  r.get('/clinic/branches', auth, ctx, async (req, res) => {
    res.json({ data: await clinics.listBranches(principalOf(req), requireTenant(req)) });
  });
  r.post(
    '/clinic/branches',
    auth,
    ctx,
    validate({ body: branchCreateSchema }),
    async (req, res) => {
      res.status(201).json({
        data: await clinics.createBranch(
          principalOf(req),
          requireTenant(req),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get('/clinic/branches/:branchId', auth, ctx, branchParams, async (req, res) => {
    res.json({
      data: await clinics.getBranch(
        principalOf(req),
        requireTenant(req),
        params<{ branchId: string }>(req).branchId,
      ),
    });
  });
  r.patch(
    '/clinic/branches/:branchId',
    auth,
    ctx,
    branchParams,
    validate({ body: branchPatchSchema }),
    async (req, res) => {
      res.json({
        data: await clinics.updateBranch(
          principalOf(req),
          requireTenant(req),
          params<{ branchId: string }>(req).branchId,
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  for (const [path, status] of [
    ['activate', 'ACTIVE'],
    ['deactivate', 'INACTIVE'],
  ] as const) {
    r.post(`/clinic/branches/:branchId/${path}`, auth, ctx, branchParams, async (req, res) => {
      res.json({
        data: await clinics.setBranchStatus(
          principalOf(req),
          requireTenant(req),
          params<{ branchId: string }>(req).branchId,
          status,
          requestMeta(req),
        ),
      });
    });
  }
  r.get('/clinic/closure-requests', auth, ctx, async (req, res) => {
    res.json({ data: await lifecycle.listClosuresForClinic(principalOf(req), requireTenant(req)) });
  });
  r.post(
    '/clinic/closure-requests',
    auth,
    ctx,
    validate({ body: closureRequestSchema }),
    async (req, res) => {
      res.status(201).json({
        data: await lifecycle.requestClosure(
          principalOf(req),
          requireTenant(req),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get('/clinic/closure-requests/:id', auth, ctx, closureParams, async (req, res) => {
    res.json({
      data: await lifecycle.closureForClinic(
        principalOf(req),
        requireTenant(req),
        params<{ id: string }>(req).id,
      ),
    });
  });
  r.post('/clinic/closure-requests/:id/cancel', auth, ctx, closureParams, async (req, res) => {
    await lifecycle.cancelClosure(
      principalOf(req),
      requireTenant(req),
      params<{ id: string }>(req).id,
      requestMeta(req),
    );
    res.status(204).end();
  });
  r.post(
    '/clinic/closure-requests/:id/actions/:actionId/resolve',
    auth,
    ctx,
    actionParams,
    validate({ body: noteBody }),
    async (req, res) => {
      const x = params<{ id: string; actionId: string }>(req);
      await lifecycle.resolveActionAsClinic(
        principalOf(req),
        requireTenant(req),
        x.id,
        x.actionId,
        body<{ note: string }>(req).note,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );

  // ---------- Super Admin ----------
  r.get(
    '/admin/clinics',
    auth,
    validate({
      query: pageQuery.extend({ operationalStatus: z.enum(OPERATIONAL_STATUSES).optional() }),
    }),
    async (req, res) => {
      res.json(await platform.list(principalOf(req), query(req)));
    },
  );
  r.get('/admin/clinics/:clinicId', auth, clinicParams, async (req, res) => {
    res.json({
      data: await platform.detail(principalOf(req), params<{ clinicId: string }>(req).clinicId),
    });
  });
  r.post(
    '/admin/clinics/:clinicId/suspend',
    auth,
    clinicParams,
    validate({ body: suspensionSchema }),
    async (req, res) => {
      await lifecycle.suspend(
        principalOf(req),
        params<{ clinicId: string }>(req).clinicId,
        body(req),
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  r.post(
    '/admin/clinics/:clinicId/reinstate',
    auth,
    clinicParams,
    validate({ body: reasonBody }),
    async (req, res) => {
      await lifecycle.reinstate(
        principalOf(req),
        params<{ clinicId: string }>(req).clinicId,
        body<{ reason: string }>(req).reason,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  r.get('/admin/clinics/:clinicId/suspensions', auth, clinicParams, async (req, res) => {
    res.json({
      data: await lifecycle.suspensions(
        principalOf(req),
        params<{ clinicId: string }>(req).clinicId,
      ),
    });
  });
  r.get('/admin/clinics/:clinicId/access-exceptions', auth, clinicParams, async (req, res) => {
    res.json({
      data: await lifecycle.accessExceptions(
        principalOf(req),
        params<{ clinicId: string }>(req).clinicId,
      ),
    });
  });
  r.post(
    '/admin/clinics/:clinicId/access-exceptions',
    auth,
    clinicParams,
    validate({ body: accessExceptionSchema }),
    async (req, res) => {
      res.status(201).json({
        data: {
          id: await lifecycle.grantAccessException(
            principalOf(req),
            params<{ clinicId: string }>(req).clinicId,
            body(req),
            requestMeta(req),
          ),
        },
      });
    },
  );
  r.post(
    '/admin/clinics/:clinicId/access-exceptions/:exceptionId/revoke',
    auth,
    p({ clinicId: idSchema, exceptionId: idSchema }),
    async (req, res) => {
      const x = params<{ clinicId: string; exceptionId: string }>(req);
      await lifecycle.revokeAccessException(
        principalOf(req),
        x.clinicId,
        x.exceptionId,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  r.get(
    '/admin/closure-requests',
    auth,
    validate({ query: pageQuery.extend({ status: z.enum(CLOSURE_STATUSES).optional() }) }),
    async (req, res) => {
      res.json(await lifecycle.listClosuresForPlatform(principalOf(req), query(req)));
    },
  );
  r.get('/admin/closure-requests/:id', auth, closureParams, async (req, res) => {
    res.json({
      data: await lifecycle.closureForPlatform(principalOf(req), params<{ id: string }>(req).id),
    });
  });
  for (const [path, method] of [
    ['approve', 'approveClosure'],
    ['reject', 'rejectClosure'],
    ['complete', 'completeClosure'],
  ] as const) {
    r.post(
      `/admin/closure-requests/:id/${path}`,
      auth,
      closureParams,
      validate({ body: reasonBody }),
      async (req, res) => {
        await lifecycle[method](
          principalOf(req),
          params<{ id: string }>(req).id,
          body<{ reason: string }>(req).reason,
          requestMeta(req),
        );
        res.status(204).end();
      },
    );
  }
  for (const [path, status] of [
    ['resolve', 'RESOLVED'],
    ['waive', 'WAIVED'],
  ] as const) {
    r.post(
      `/admin/closure-requests/:id/actions/:actionId/${path}`,
      auth,
      actionParams,
      validate({ body: noteBody }),
      async (req, res) => {
        const x = params<{ id: string; actionId: string }>(req);
        await lifecycle.decideActionAsPlatform(
          principalOf(req),
          x.id,
          x.actionId,
          status,
          body<{ note: string }>(req).note,
          requestMeta(req),
        );
        res.status(204).end();
      },
    );
  }
  return r;
}
