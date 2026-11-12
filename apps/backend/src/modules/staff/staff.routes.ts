import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { body, pageQuery, params, query } from '../../shared/http/route-helpers.js';
import { MEMBERSHIP_STATUSES } from '../access/tenancy/memberships.repository.js';
import { principalOf, requireTenant } from '../access/index.js';
import { normalizePhone } from '../iam/index.js';
import { idSchema } from '../platform/index.js';
import {
  branchAssignmentSchema,
  invitationCreateSchema,
  type StaffService,
} from './staff.service.js';

const memberParams = validate({ params: z.object({ membershipId: idSchema }) });
const statusBody = z
  .object({ status: z.enum(MEMBERSHIP_STATUSES), reason: z.string().trim().min(3).max(255) })
  .strict();
const tokenBody = z.object({ token: z.string().min(20).max(200) }).strict();

export function createStaffRouter(deps: {
  authenticate: RequestHandler;
  clinicContext: RequestHandler;
  staff: StaffService;
  phoneDefaultRegion: string | undefined;
}): Router {
  const r = Router();
  const { authenticate: auth, clinicContext: ctx, staff: svc } = deps;

  r.get(
    '/clinic/members',
    auth,
    ctx,
    validate({ query: pageQuery.extend({ status: z.enum(MEMBERSHIP_STATUSES).optional() }) }),
    async (req, res) => {
      res.json(await svc.listMembers(principalOf(req), requireTenant(req), query(req)));
    },
  );
  r.patch(
    '/clinic/members/:membershipId/status',
    auth,
    ctx,
    memberParams,
    validate({ body: statusBody }),
    async (req, res) => {
      const b = body<z.infer<typeof statusBody>>(req);
      await svc.changeStatus(
        principalOf(req),
        requireTenant(req),
        params<{ membershipId: string }>(req).membershipId,
        b.status,
        b.reason,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  r.put(
    '/clinic/members/:membershipId/branches',
    auth,
    ctx,
    memberParams,
    validate({ body: branchAssignmentSchema }),
    async (req, res) => {
      await svc.setBranches(
        principalOf(req),
        requireTenant(req),
        params<{ membershipId: string }>(req).membershipId,
        body(req),
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  r.patch(
    '/clinic/members/:membershipId/public-listing',
    auth,
    ctx,
    memberParams,
    validate({ body: z.object({ publicListing: z.boolean() }).strict() }),
    async (req, res) => {
      await svc.setDoctorPublicListing(
        principalOf(req),
        requireTenant(req),
        params<{ membershipId: string }>(req).membershipId,
        body<{ publicListing: boolean }>(req).publicListing,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );

  r.get(
    '/clinic/invitations',
    auth,
    ctx,
    validate({
      query: z.object({
        status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED']).optional(),
      }),
    }),
    async (req, res) => {
      res.json({
        data: await svc.listInvitations(
          principalOf(req),
          requireTenant(req),
          query<{ status?: 'PENDING' }>(req).status,
        ),
      });
    },
  );
  r.post(
    '/clinic/invitations',
    auth,
    ctx,
    validate({ body: invitationCreateSchema }),
    async (req, res) => {
      const b = body<z.infer<typeof invitationCreateSchema>>(req);
      res.status(201).json({
        data: await svc.invite(
          principalOf(req),
          requireTenant(req),
          {
            phoneE164: normalizePhone(b.phone, deps.phoneDefaultRegion),
            role: b.role,
            branchScope: b.branchScope,
            branchIds: b.branchIds,
          },
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/clinic/invitations/:id/revoke',
    auth,
    ctx,
    validate({ params: z.object({ id: idSchema }) }),
    async (req, res) => {
      await svc.revoke(
        principalOf(req),
        requireTenant(req),
        params<{ id: string }>(req).id,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );

  r.get('/me/invitations', auth, async (req, res) => {
    res.json({ data: await svc.myInvitations(principalOf(req)) });
  });
  r.post('/invitations/accept', auth, validate({ body: tokenBody }), async (req, res) => {
    res.json({
      data: await svc.accept(
        principalOf(req),
        body<{ token: string }>(req).token,
        requestMeta(req),
      ),
    });
  });
  r.post('/invitations/decline', auth, validate({ body: tokenBody }), async (req, res) => {
    await svc.decline(principalOf(req), body<{ token: string }>(req).token, requestMeta(req));
    res.status(204).end();
  });
  return r;
}
