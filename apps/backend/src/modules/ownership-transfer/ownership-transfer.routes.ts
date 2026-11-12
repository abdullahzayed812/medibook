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
import { normalizePhone } from '../iam/index.js';
import { idSchema, rawDocumentBody, sendDocument, uploadInput } from '../platform/index.js';
import { TRANSFER_STATUSES, type OwnershipTransferService } from './ownership-transfer.service.js';

const idParams = validate({ params: z.object({ id: idSchema }) });
const docParams = validate({ params: z.object({ id: idSchema, documentId: idSchema }) });
const initiateBody = z
  .object({
    phone: z.string().min(1).max(32),
    reason: z.string().trim().min(3).max(1000).optional(),
  })
  .strict();
const identityBody = noteBody.extend({ result: z.enum(['VERIFIED', 'FAILED']) }).strict();

export function createOwnershipTransferRouter(deps: {
  authenticate: RequestHandler;
  clinicContext: RequestHandler;
  transfers: OwnershipTransferService;
  phoneDefaultRegion: string | undefined;
}): Router {
  const r = Router();
  const { authenticate: auth, clinicContext: ctx, transfers: svc } = deps;

  // Current owner (clinic context)
  r.get('/clinic/ownership-transfers', auth, ctx, async (req, res) => {
    res.json({ data: await svc.listForClinic(principalOf(req), requireTenant(req)) });
  });
  r.post(
    '/clinic/ownership-transfers',
    auth,
    ctx,
    validate({ body: initiateBody }),
    async (req, res) => {
      const b = body<z.infer<typeof initiateBody>>(req);
      res.status(201).json({
        data: await svc.initiate(
          principalOf(req),
          requireTenant(req),
          { toPhoneE164: normalizePhone(b.phone, deps.phoneDefaultRegion), reason: b.reason },
          requestMeta(req),
        ),
      });
    },
  );
  r.post('/clinic/ownership-transfers/:id/cancel', auth, ctx, idParams, async (req, res) => {
    await svc.cancel(
      principalOf(req),
      requireTenant(req),
      params<{ id: string }>(req).id,
      requestMeta(req),
    );
    res.status(204).end();
  });

  // Parties (no clinic context: the recipient is not a member yet)
  r.get('/ownership-transfers/incoming', auth, async (req, res) => {
    res.json({ data: await svc.incoming(principalOf(req)) });
  });
  r.get('/ownership-transfers/:id', auth, idParams, async (req, res) => {
    res.json({ data: await svc.getAsParty(principalOf(req), params<{ id: string }>(req).id) });
  });
  r.post('/ownership-transfers/:id/accept', auth, idParams, async (req, res) => {
    res.json({
      data: await svc.accept(principalOf(req), params<{ id: string }>(req).id, requestMeta(req)),
    });
  });
  r.post('/ownership-transfers/:id/decline', auth, idParams, async (req, res) => {
    res.json({
      data: await svc.decline(principalOf(req), params<{ id: string }>(req).id, requestMeta(req)),
    });
  });
  r.post(
    '/ownership-transfers/:id/documents',
    auth,
    idParams,
    rawDocumentBody,
    async (req, res) => {
      res.status(201).json({
        data: await svc.uploadDocument(
          principalOf(req),
          params<{ id: string }>(req).id,
          uploadInput(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get(
    '/ownership-transfers/:id/documents/:documentId/content',
    auth,
    docParams,
    async (req, res) => {
      const x = params<{ id: string; documentId: string }>(req);
      sendDocument(res, await svc.readDocumentAsParty(principalOf(req), x.id, x.documentId));
    },
  );

  // Super Admin
  r.get(
    '/admin/ownership-transfers',
    auth,
    validate({ query: pageQuery.extend({ status: z.enum(TRANSFER_STATUSES).optional() }) }),
    async (req, res) => {
      res.json(await svc.list(principalOf(req), query(req)));
    },
  );
  r.get('/admin/ownership-transfers/:id', auth, idParams, async (req, res) => {
    res.json({ data: await svc.getForReview(principalOf(req), params<{ id: string }>(req).id) });
  });
  r.get(
    '/admin/ownership-transfers/:id/documents/:documentId/content',
    auth,
    docParams,
    async (req, res) => {
      const x = params<{ id: string; documentId: string }>(req);
      sendDocument(
        res,
        await svc.readDocumentForReview(principalOf(req), x.id, x.documentId, requestMeta(req)),
      );
    },
  );
  r.post(
    '/admin/ownership-transfers/:id/identity',
    auth,
    idParams,
    validate({ body: identityBody }),
    async (req, res) => {
      const b = body<z.infer<typeof identityBody>>(req);
      res.json({
        data: await svc.recordIdentityVerification(
          principalOf(req),
          params<{ id: string }>(req).id,
          b.result,
          b.note,
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/admin/ownership-transfers/:id/approve',
    auth,
    idParams,
    validate({ body: reasonBody }),
    async (req, res) => {
      res.json({
        data: await svc.approve(
          principalOf(req),
          params<{ id: string }>(req).id,
          body<{ reason: string }>(req).reason,
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/admin/ownership-transfers/:id/reject',
    auth,
    idParams,
    validate({ body: reasonBody }),
    async (req, res) => {
      await svc.reject(
        principalOf(req),
        params<{ id: string }>(req).id,
        body<{ reason: string }>(req).reason,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  return r;
}
