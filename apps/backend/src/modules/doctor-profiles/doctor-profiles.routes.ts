import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { body, pageQuery, params, query } from '../../shared/http/route-helpers.js';
import { principalOf } from '../access/index.js';
import { idSchema, rawDocumentBody, sendDocument, uploadInput } from '../platform/index.js';
import {
  doctorProfileInputSchema,
  doctorProfilePatchSchema,
  VERIFICATION_DECISIONS,
  VERIFICATION_STATUSES,
  type DoctorProfileService,
  type SpecialtyService,
  type VerificationDecision,
} from './doctor-profiles.service.js';

const decisionBody = z
  .object({
    decision: z.enum(
      Object.keys(VERIFICATION_DECISIONS) as [VerificationDecision, ...VerificationDecision[]],
    ),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
const specialtyBody = z
  .object({ name: z.string().trim().min(2).max(150), active: z.boolean().optional() })
  .strict();

export function createDoctorProfilesRouter(deps: {
  authenticate: RequestHandler;
  doctors: DoctorProfileService;
  specialties: SpecialtyService;
}): Router {
  const r = Router();
  const { authenticate: auth, doctors: svc } = deps;

  r.get('/specialties', async (_req, res) => {
    res.json({ data: await deps.specialties.listActive() });
  });

  // The doctor's own global profile
  r.post(
    '/me/doctor-profile',
    auth,
    validate({ body: doctorProfileInputSchema }),
    async (req, res) => {
      res
        .status(201)
        .json({ data: await svc.createOwn(principalOf(req), body(req), requestMeta(req)) });
    },
  );
  r.get('/me/doctor-profile', auth, async (req, res) => {
    res.json({ data: await svc.getOwn(principalOf(req)) });
  });
  r.patch(
    '/me/doctor-profile',
    auth,
    validate({ body: doctorProfilePatchSchema }),
    async (req, res) => {
      res.json({ data: await svc.updateOwn(principalOf(req), body(req), requestMeta(req)) });
    },
  );
  r.post('/me/doctor-profile/documents', auth, rawDocumentBody, async (req, res) => {
    res.status(201).json({
      data: await svc.uploadDocument(principalOf(req), uploadInput(req), requestMeta(req)),
    });
  });
  r.get(
    '/me/doctor-profile/documents/:documentId/content',
    auth,
    validate({ params: z.object({ documentId: idSchema }) }),
    async (req, res) => {
      sendDocument(
        res,
        await svc.readOwnDocument(principalOf(req), params<{ documentId: string }>(req).documentId),
      );
    },
  );
  r.post('/me/doctor-profile/verification', auth, async (req, res) => {
    res.json({ data: await svc.submitForVerification(principalOf(req), requestMeta(req)) });
  });

  // Super Admin
  r.get(
    '/admin/doctor-profiles',
    auth,
    validate({ query: pageQuery.extend({ status: z.enum(VERIFICATION_STATUSES).optional() }) }),
    async (req, res) => {
      res.json(await svc.listForReview(principalOf(req), query(req)));
    },
  );
  r.get(
    '/admin/doctor-profiles/:id',
    auth,
    validate({ params: z.object({ id: idSchema }) }),
    async (req, res) => {
      res.json({ data: await svc.getForReview(principalOf(req), params<{ id: string }>(req).id) });
    },
  );
  r.get(
    '/admin/doctor-profiles/:id/documents/:documentId/content',
    auth,
    validate({ params: z.object({ id: idSchema, documentId: idSchema }) }),
    async (req, res) => {
      const x = params<{ id: string; documentId: string }>(req);
      sendDocument(
        res,
        await svc.readDocumentForReview(principalOf(req), x.id, x.documentId, requestMeta(req)),
      );
    },
  );
  r.post(
    '/admin/doctor-profiles/:id/verification',
    auth,
    validate({ params: z.object({ id: idSchema }), body: decisionBody }),
    async (req, res) => {
      const b = body<z.infer<typeof decisionBody>>(req);
      res.json({
        data: await svc.decide(
          principalOf(req),
          params<{ id: string }>(req).id,
          b.decision,
          b.reason,
          requestMeta(req),
        ),
      });
    },
  );
  r.put(
    '/admin/specialties/:code',
    auth,
    validate({
      params: z.object({
        code: z
          .string()
          .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)
          .max(50),
      }),
      body: specialtyBody,
    }),
    async (req, res) => {
      await deps.specialties.upsert(
        principalOf(req),
        { code: params<{ code: string }>(req).code, ...body<z.infer<typeof specialtyBody>>(req) },
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  return r;
}
