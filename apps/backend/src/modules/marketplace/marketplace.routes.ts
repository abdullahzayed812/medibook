import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { body, pageQuery, params, query } from '../../shared/http/route-helpers.js';
import { principalOf, requireTenant } from '../access/index.js';
import { idSchema } from '../platform/index.js';
import { visibilityPatchSchema, type MarketplaceService } from './marketplace.service.js';

export function createMarketplaceRouter(deps: {
  authenticate: RequestHandler;
  clinicContext: RequestHandler;
  marketplace: MarketplaceService;
}): Router {
  const r = Router();
  const { authenticate: auth, clinicContext: ctx, marketplace: svc } = deps;

  r.get('/clinic/marketplace', auth, ctx, async (req, res) => {
    res.json({ data: await svc.settings(principalOf(req), requireTenant(req)) });
  });
  r.patch(
    '/clinic/marketplace',
    auth,
    ctx,
    validate({ body: visibilityPatchSchema }),
    async (req, res) => {
      res.json({
        data: await svc.updateSettings(
          principalOf(req),
          requireTenant(req),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );

  // Public, unauthenticated, read-only. Non-eligible resources are 404.
  r.get('/public/clinics', validate({ query: pageQuery }), async (req, res) => {
    res.json(await svc.listPublicClinics(query(req)));
  });
  r.get(
    '/public/clinics/:id',
    validate({ params: z.object({ id: idSchema }) }),
    async (req, res) => {
      res.json({ data: await svc.publicClinic(params<{ id: string }>(req).id) });
    },
  );
  r.get(
    '/public/doctors/:id',
    validate({ params: z.object({ id: idSchema }) }),
    async (req, res) => {
      res.json({ data: await svc.publicDoctor(params<{ id: string }>(req).id) });
    },
  );
  return r;
}
