import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { body, pageQuery, params, query, reasonBody } from '../../shared/http/route-helpers.js';
import { principalOf, requireTenant } from '../access/index.js';
import { idSchema, settingsPatchSchema, type PlatformSettingsService } from '../platform/index.js';
import {
  planCreateSchema,
  planVersionInputSchema,
  type PlansService,
  type SubscriptionService,
} from './subscription.service.js';

const clinicParams = validate({ params: z.object({ clinicId: idSchema }) });
const planParams = validate({ params: z.object({ planId: idSchema }) });
const paymentBody = z
  .object({
    billingCycle: z.enum(['MONTHLY', 'ANNUAL']).optional(),
    reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export function createSubscriptionsRouter(deps: {
  authenticate: RequestHandler;
  clinicContext: RequestHandler;
  plans: PlansService;
  subscriptions: SubscriptionService;
  settings: PlatformSettingsService;
}): Router {
  const r = Router();
  const { authenticate: auth, clinicContext: ctx, plans, subscriptions: subs } = deps;
  const clinicId = (req: Parameters<RequestHandler>[0]) =>
    params<{ clinicId: string }>(req).clinicId;

  // Public pricing: active plans with their current terms.
  r.get('/plans', async (_req, res) => {
    res.json({
      data: (await plans.list()).filter((p) => p.status === 'ACTIVE' && p.currentVersion !== null),
    });
  });

  // Clinic side
  r.get('/clinic/subscription', auth, ctx, async (req, res) => {
    res.json({ data: await subs.viewForClinic(principalOf(req), requireTenant(req)) });
  });
  r.get(
    '/clinic/subscription/history',
    auth,
    ctx,
    validate({ query: pageQuery }),
    async (req, res) => {
      res.json(await subs.historyForClinic(principalOf(req), requireTenant(req), query(req)));
    },
  );

  // Super Admin: plans
  r.post('/admin/plans', auth, validate({ body: planCreateSchema }), async (req, res) => {
    res
      .status(201)
      .json({ data: await plans.create(principalOf(req), body(req), requestMeta(req)) });
  });
  r.get('/admin/plans/:planId', auth, planParams, async (req, res) => {
    res.json({ data: await plans.get(principalOf(req), params<{ planId: string }>(req).planId) });
  });
  r.post(
    '/admin/plans/:planId/versions',
    auth,
    planParams,
    validate({ body: planVersionInputSchema }),
    async (req, res) => {
      res.status(201).json({
        data: await plans.addVersion(
          principalOf(req),
          params<{ planId: string }>(req).planId,
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
    r.post(`/admin/plans/:planId/${path}`, auth, planParams, async (req, res) => {
      await plans.setStatus(
        principalOf(req),
        params<{ planId: string }>(req).planId,
        status,
        requestMeta(req),
      );
      res.status(204).end();
    });
  }

  // Super Admin: clinic subscriptions
  r.get('/admin/clinics/:clinicId/subscription', auth, clinicParams, async (req, res) => {
    res.json({ data: await subs.viewForPlatform(principalOf(req), clinicId(req)) });
  });
  r.get(
    '/admin/clinics/:clinicId/subscription/history',
    auth,
    clinicParams,
    validate({ query: pageQuery }),
    async (req, res) => {
      res.json(await subs.historyForPlatform(principalOf(req), clinicId(req), query(req)));
    },
  );
  r.post(
    '/admin/clinics/:clinicId/subscription/payments',
    auth,
    clinicParams,
    validate({ body: paymentBody }),
    async (req, res) => {
      res.json({
        data: await subs.recordPayment(
          principalOf(req),
          clinicId(req),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/admin/clinics/:clinicId/subscription/change-plan',
    auth,
    clinicParams,
    validate({ body: reasonBody.extend({ planId: idSchema }) }),
    async (req, res) => {
      const b = body<{ planId: string; reason: string }>(req);
      res.json({
        data: await subs.changePlan(
          principalOf(req),
          clinicId(req),
          b.planId,
          b.reason,
          requestMeta(req),
        ),
      });
    },
  );
  for (const [path, status] of [
    ['suspend', 'SUSPENDED'],
    ['expire', 'EXPIRED'],
  ] as const) {
    r.post(
      `/admin/clinics/:clinicId/subscription/${path}`,
      auth,
      clinicParams,
      validate({ body: reasonBody }),
      async (req, res) => {
        res.json({
          data: await subs.setStatus(
            principalOf(req),
            clinicId(req),
            status,
            body<{ reason: string }>(req).reason,
            requestMeta(req),
          ),
        });
      },
    );
  }
  r.post(
    '/admin/clinics/:clinicId/subscription/reactivate',
    auth,
    clinicParams,
    validate({ body: reasonBody }),
    async (req, res) => {
      res.json({
        data: await subs.reactivate(
          principalOf(req),
          clinicId(req),
          body<{ reason: string }>(req).reason,
          requestMeta(req),
        ),
      });
    },
  );
  r.put(
    '/admin/clinics/:clinicId/subscription/grace-period',
    auth,
    clinicParams,
    validate({ body: reasonBody.extend({ days: z.number().int().min(0).max(60).nullable() }) }),
    async (req, res) => {
      const b = body<{ days: number | null; reason: string }>(req);
      res.json({
        data: await subs.setGracePeriod(
          principalOf(req),
          clinicId(req),
          b.days,
          b.reason,
          requestMeta(req),
        ),
      });
    },
  );

  // Super Admin: platform settings
  r.get('/admin/settings', auth, async (req, res) => {
    res.json({ data: await deps.settings.view(principalOf(req)) });
  });
  r.patch('/admin/settings', auth, validate({ body: settingsPatchSchema }), async (req, res) => {
    res.json({ data: await deps.settings.update(principalOf(req), body(req), requestMeta(req)) });
  });
  return r;
}
