import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { body, pageQuery, params, query, reasonBody } from '../../shared/http/route-helpers.js';
import { principalOf } from '../access/index.js';
import { idSchema, rawDocumentBody, sendDocument, uploadInput } from '../platform/index.js';
import {
  REGISTRATION_STATUSES,
  registrationFieldsSchema,
  registrationPatchSchema,
  type RegistrationFields,
} from './registration.js';
import type { RegistrationService } from './registration.service.js';

const idParams = validate({ params: z.object({ id: idSchema }) });
const docParams = validate({ params: z.object({ id: idSchema, documentId: idSchema }) });
const approveBody = z
  .object({
    planId: idSchema,
    billingCycle: z.enum(['MONTHLY', 'ANNUAL']),
    reason: z.string().trim().min(3).max(1000).optional(),
  })
  .strict();
const listQuery = pageQuery.extend({
  status: z.enum(REGISTRATION_STATUSES).optional(),
  sort: z.enum(['submitted_asc', 'newest']).default('submitted_asc'),
});

export function createRegistrationRouter(deps: {
  authenticate: RequestHandler;
  registrations: RegistrationService;
}): Router {
  const r = Router();
  const { authenticate: auth, registrations: svc } = deps;

  // Applicant
  r.post('/registrations', auth, validate({ body: registrationFieldsSchema }), async (req, res) => {
    res.status(201).json({
      data: await svc.createDraft(
        principalOf(req),
        body<RegistrationFields>(req),
        requestMeta(req),
      ),
    });
  });
  r.get('/registrations', auth, async (req, res) => {
    res.json({ data: await svc.listMine(principalOf(req)) });
  });
  r.get('/registrations/:id', auth, idParams, async (req, res) => {
    res.json({ data: await svc.getMine(principalOf(req), params<{ id: string }>(req).id) });
  });
  r.patch(
    '/registrations/:id',
    auth,
    idParams,
    validate({ body: registrationPatchSchema }),
    async (req, res) => {
      res.json({
        data: await svc.update(
          principalOf(req),
          params<{ id: string }>(req).id,
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.post('/registrations/:id/submit', auth, idParams, async (req, res) => {
    res.json({
      data: await svc.submit(principalOf(req), params<{ id: string }>(req).id, requestMeta(req)),
    });
  });
  r.post('/registrations/:id/documents', auth, idParams, rawDocumentBody, async (req, res) => {
    res.status(201).json({
      data: await svc.uploadDocument(
        principalOf(req),
        params<{ id: string }>(req).id,
        uploadInput(req),
        requestMeta(req),
      ),
    });
  });
  r.delete('/registrations/:id/documents/:documentId', auth, docParams, async (req, res) => {
    const p = params<{ id: string; documentId: string }>(req);
    await svc.removeDocument(principalOf(req), p.id, p.documentId, requestMeta(req));
    res.status(204).end();
  });
  r.get('/registrations/:id/documents/:documentId/content', auth, docParams, async (req, res) => {
    const p = params<{ id: string; documentId: string }>(req);
    sendDocument(res, await svc.readOwnDocument(principalOf(req), p.id, p.documentId));
  });

  // Super Admin review
  r.get('/admin/registrations', auth, validate({ query: listQuery }), async (req, res) => {
    res.json(await svc.list(principalOf(req), query(req)));
  });
  r.get('/admin/registrations/:id', auth, idParams, async (req, res) => {
    res.json({ data: await svc.getForReview(principalOf(req), params<{ id: string }>(req).id) });
  });
  r.get(
    '/admin/registrations/:id/documents/:documentId/content',
    auth,
    docParams,
    async (req, res) => {
      const p = params<{ id: string; documentId: string }>(req);
      sendDocument(
        res,
        await svc.readDocumentForReview(principalOf(req), p.id, p.documentId, requestMeta(req)),
      );
    },
  );
  r.post('/admin/registrations/:id/start-review', auth, idParams, async (req, res) => {
    res.json({
      data: await svc.startReview(
        principalOf(req),
        params<{ id: string }>(req).id,
        requestMeta(req),
      ),
    });
  });
  for (const [path, method] of [
    ['request-information', 'requestInformation'],
    ['reject', 'reject'],
    ['suspend', 'suspend'],
    ['resume', 'resume'],
  ] as const) {
    r.post(
      `/admin/registrations/:id/${path}`,
      auth,
      idParams,
      validate({ body: reasonBody }),
      async (req, res) => {
        res.json({
          data: await svc[method](
            principalOf(req),
            params<{ id: string }>(req).id,
            body<{ reason: string }>(req).reason,
            requestMeta(req),
          ),
        });
      },
    );
  }
  r.post(
    '/admin/registrations/:id/approve',
    auth,
    idParams,
    validate({ body: approveBody }),
    async (req, res) => {
      res.json({
        data: await svc.approve(
          principalOf(req),
          params<{ id: string }>(req).id,
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  return r;
}
