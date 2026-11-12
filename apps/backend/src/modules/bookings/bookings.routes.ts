import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { body, pageQuery, params, query } from '../../shared/http/route-helpers.js';
import { principalOf, requireTenant } from '../access/index.js';
import { normalizePhone } from '../iam/index.js';
import { idSchema } from '../platform/index.js';
import type { AvailabilityService } from './availability.js';
import type { BookingService } from './bookings.service.js';
import { RELATIONSHIPS, type PersonsService } from './persons.service.js';
import { BOOKING_LIMITS, BOOKING_STATUSES } from './policy.js';
import type { BookingSettingsService } from './settings.service.js';
import type { IdentityAdminService } from './identity-links.js';

const date = z.iso.date();
const reason = z.string().trim().min(3).max(1000);
const slotFields = {
  clinicId: idSchema,
  branchId: idSchema,
  serviceId: idSchema,
  assignmentId: idSchema,
  startsAt: z.iso.datetime({ offset: true }),
  note: z.string().trim().min(1).max(500).nullable().optional(),
};
const availabilityQuery = z.object({
  clinicId: idSchema,
  branchId: idSchema,
  serviceId: idSchema,
  assignmentId: idSchema.optional(),
  from: date,
  to: date,
  mode: z.enum(['SLOT', 'QUEUE']).default('SLOT'),
});
const listQuery = pageQuery.extend({ status: z.enum(BOOKING_STATUSES).optional() });
const range = (l: { min: number; max: number }) => z.number().int().min(l.min).max(l.max);
const settingsPatch = z
  .object({
    slotEnabled: z.boolean().optional(),
    queueEnabled: z.boolean().optional(),
    slotIntervalMinutes: range(BOOKING_LIMITS.slotIntervalMinutes).optional(),
    minLeadMinutes: range(BOOKING_LIMITS.minLeadMinutes).optional(),
    maxHorizonDays: range(BOOKING_LIMITS.maxHorizonDays).optional(),
    confirmationTtlMinutes: range(BOOKING_LIMITS.confirmationTtlMinutes).optional(),
    cancelMinNoticeMinutes: range(BOOKING_LIMITS.cancelMinNoticeMinutes).optional(),
    cancelReasonRequired: z.boolean().optional(),
  })
  .strict();

const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,128}$/;
/** `Idempotency-Key` header: required on booking creation and reschedule requests. */
function idemKey(req: Request, required: true): string;
function idemKey(req: Request, required: false): string | undefined;
function idemKey(req: Request, required: boolean): string | undefined {
  const key = req.get('idempotency-key');
  if (key === undefined) {
    if (required)
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header');
    return undefined;
  }
  if (!IDEMPOTENCY.test(key))
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_INVALID',
      'Idempotency-Key must be 8–128 of [A-Za-z0-9_-]',
    );
  return key;
}

/**
 * Booking API. Three audiences, never mixed:
 *  - public / patients (`/availability`, `/me/...`): own bookings and persons only;
 *  - guests (`/guest/...`, `X-Guest-Token` from a verified phone): that phone's bookings only;
 *  - clinic staff (`/clinic/...`, `X-Clinic-Id`): their clinic and covered branches only.
 * There are no worker or maintenance endpoints.
 */
export function createBookingsRouter(deps: {
  authenticate: RequestHandler;
  clinicContext: RequestHandler;
  availability: AvailabilityService;
  bookings: BookingService;
  persons: PersonsService;
  settings: BookingSettingsService;
  identityAdmin: IdentityAdminService;
  phoneDefaultRegion?: string | undefined;
}): Router {
  const r = Router();
  const { authenticate: auth, clinicContext: ctx, bookings, persons } = deps;
  const bookingId = validate({ params: z.object({ bookingId: idSchema }) });
  const id = (req: Request) => params<{ bookingId: string }>(req).bookingId;
  const phone = (raw: string) => normalizePhone(raw, deps.phoneDefaultRegion);
  const guest = (req: Request) => persons.resolveGuest(req.get('x-guest-token'));

  // ---------- availability ----------
  r.get('/availability', validate({ query: availabilityQuery }), async (req, res) => {
    res.json({ data: await deps.availability.query(query(req)) });
  });
  r.get(
    '/me/availability',
    auth,
    validate({ query: availabilityQuery.extend({ personId: idSchema.optional() }) }),
    async (req, res) => {
      const principal = principalOf(req);
      const q = query<z.infer<typeof availabilityQuery> & { personId?: string }>(req);
      const person = await persons.subjectFor(principal.userId, q.personId, requestMeta(req));
      res.json({ data: await deps.availability.query({ ...q, personId: person.id }) });
    },
  );

  // ---------- persons & delegation ----------
  r.get('/me/booking-persons', auth, async (req, res) => {
    res.json({ data: await persons.bookablePersons(principalOf(req).userId, requestMeta(req)) });
  });
  r.post(
    '/me/dependents',
    auth,
    validate({
      body: z
        .object({
          displayName: z.string().trim().min(2).max(150),
          birthDate: date.optional(),
          relationship: z.enum(RELATIONSHIPS),
          authorityStatement: z.string().trim().max(500).optional(),
        })
        .strict(),
    }),
    async (req, res) => {
      res.status(201).json({
        data: await persons.createDependent(principalOf(req).userId, body(req), requestMeta(req)),
      });
    },
  );
  r.get('/me/delegates', auth, async (req, res) => {
    res.json({ data: await persons.grantedDelegations(principalOf(req).userId, requestMeta(req)) });
  });
  r.post(
    '/me/delegates',
    auth,
    validate({
      body: z.object({ phone: z.string().max(32), relationship: z.enum(RELATIONSHIPS) }).strict(),
    }),
    async (req, res) => {
      const b = body<{ phone: string; relationship: (typeof RELATIONSHIPS)[number] }>(req);
      res.status(201).json({
        data: await persons.grantConsent(
          principalOf(req).userId,
          { phoneE164: phone(b.phone), relationship: b.relationship },
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/me/delegations/:delegationId/revoke',
    auth,
    validate({ params: z.object({ delegationId: idSchema }) }),
    async (req, res) => {
      await persons.revoke(
        principalOf(req).userId,
        params<{ delegationId: string }>(req).delegationId,
        requestMeta(req),
      );
      res.status(204).end();
    },
  );
  // Ownership of guest bookings needs the claim code — never the phone number alone.
  r.post(
    '/me/guest-bookings/claim',
    auth,
    validate({
      body: z
        .object({ claimCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid claim code') })
        .strict(),
    }),
    async (req, res) => {
      res.json({
        data: await persons.claimWithCode(
          principalOf(req).userId,
          body<{ claimCode: string }>(req).claimCode,
          requestMeta(req),
        ),
      });
    },
  );
  r.get('/me/identity-cases', auth, async (req, res) => {
    res.json({ data: await persons.myIdentityCases(principalOf(req).userId) });
  });
  r.post(
    '/me/identity-cases',
    auth,
    validate({
      body: z
        .object({
          statement: z.string().trim().min(20).max(1000),
          bookingReference: idSchema.optional(),
          kind: z.enum(['GUEST_OWNERSHIP', 'IDENTITY_LINK']).optional(),
        })
        .strict(),
    }),
    async (req, res) => {
      res.status(202).json({
        data: await persons.openIdentityCase(principalOf(req).userId, body(req), requestMeta(req)),
      });
    },
  );
  r.get(
    '/admin/identity-cases',
    auth,
    validate({ query: z.object({ status: z.enum(['OPEN', 'LINKED', 'REJECTED']).optional() }) }),
    async (req, res) => {
      res.json({
        data: await persons.listIdentityCases(
          principalOf(req),
          query<{ status?: 'OPEN' }>(req).status,
        ),
      });
    },
  );
  r.post(
    '/admin/identity-cases/:caseId/resolve',
    auth,
    validate({
      params: z.object({ caseId: idSchema }),
      body: z
        .object({
          decision: z.enum(['LINK', 'REJECT']),
          personId: idSchema.optional(),
          reason: reason,
          verificationNote: z.string().trim().min(10).max(1000),
          evidenceType: z
            .enum(['ID_DOCUMENT', 'BOOKING_DETAILS', 'CLINIC_ATTESTATION', 'OTHER'])
            .optional(),
        })
        .strict(),
    }),
    async (req, res) => {
      res.json({
        data: await persons.resolveIdentityCase(
          principalOf(req),
          params<{ caseId: string }>(req).caseId,
          body(req),
          requestMeta(req),
        ),
      });
    },
  );

  r.get(
    '/admin/booking-persons/:personId/identity-links',
    auth,
    validate({ params: z.object({ personId: idSchema }) }),
    async (req, res) => {
      res.json({
        data: await deps.identityAdmin.listLinks(
          principalOf(req),
          params<{ personId: string }>(req).personId,
        ),
      });
    },
  );
  r.post(
    '/admin/identity-links/:linkId/revoke',
    auth,
    validate({
      params: z.object({ linkId: idSchema }),
      body: z.object({ reason, releaseOwnership: z.boolean().optional() }).strict(),
    }),
    async (req, res) => {
      res.json({
        data: await deps.identityAdmin.revokeLink(
          principalOf(req),
          params<{ linkId: string }>(req).linkId,
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get(
    '/admin/identity-link-conflicts',
    auth,
    validate({ query: z.object({ status: z.enum(['OPEN', 'ALL']).default('OPEN') }) }),
    async (req, res) => {
      res.json({
        data: await deps.identityAdmin.listConflicts(
          principalOf(req),
          query<{ status: string }>(req).status === 'OPEN',
        ),
      });
    },
  );
  r.post(
    '/admin/identity-link-conflicts/:conflictId/resolve',
    auth,
    validate({
      params: z.object({ conflictId: idSchema }),
      body: z.object({ note: reason }).strict(),
    }),
    async (req, res) => {
      res.json({
        data: await deps.identityAdmin.resolveConflict(
          principalOf(req),
          params<{ conflictId: string }>(req).conflictId,
          body<{ note: string }>(req).note,
          requestMeta(req),
        ),
      });
    },
  );

  // ---------- patient bookings ----------
  r.post(
    '/me/bookings',
    auth,
    validate({ body: z.object({ ...slotFields, personId: idSchema.optional() }).strict() }),
    async (req, res) => {
      res
        .status(201)
        .json(
          await bookings.createForUser(
            principalOf(req),
            body(req),
            idemKey(req, true),
            requestMeta(req),
          ),
        );
    },
  );
  r.get('/me/bookings', auth, validate({ query: listQuery }), async (req, res) => {
    res.json(await bookings.listForPatient(principalOf(req), query(req), requestMeta(req)));
  });
  r.get('/me/bookings/:bookingId', auth, bookingId, async (req, res) => {
    res.json({ data: await bookings.getForPatient(principalOf(req), id(req), requestMeta(req)) });
  });
  r.post(
    '/me/bookings/:bookingId/cancel',
    auth,
    bookingId,
    validate({ body: z.object({ reason: reason.optional() }).strict() }),
    async (req, res) => {
      res.json(
        await bookings.cancelByPatient(
          principalOf(req),
          id(req),
          body<{ reason?: string }>(req).reason ?? null,
          requestMeta(req),
        ),
      );
    },
  );
  r.post(
    '/me/bookings/:bookingId/reschedule',
    auth,
    bookingId,
    validate({
      body: z.object({ startsAt: slotFields.startsAt, assignmentId: idSchema.optional() }).strict(),
    }),
    async (req, res) => {
      res
        .status(201)
        .json(
          await bookings.requestReschedule(
            principalOf(req),
            id(req),
            body(req),
            idemKey(req, true),
            requestMeta(req),
          ),
        );
    },
  );

  // ---------- guests ----------
  r.post(
    '/guest/verifications',
    validate({ body: z.object({ phone: z.string().max(32) }).strict() }),
    async (req, res) => {
      res.status(202).json({
        data: await persons.requestGuestCode(
          phone(body<{ phone: string }>(req).phone),
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/guest/verifications/verify',
    validate({
      body: z
        .object({
          challengeId: z.string().regex(/^[0-9a-f]{32}$/),
          phone: z.string().max(32),
          code: z.string().max(12),
        })
        .strict(),
    }),
    async (req, res) => {
      const b = body<{ challengeId: string; phone: string; code: string }>(req);
      res.set('Cache-Control', 'no-store'); // carries the guest token
      res.json({
        data: await persons.verifyGuest(
          { challengeId: b.challengeId, phoneE164: phone(b.phone), code: b.code },
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/guest/bookings',
    validate({
      body: z
        .object({
          ...slotFields,
          patient: z.object({ displayName: z.string().trim().min(2).max(150) }).strict(),
        })
        .strict(),
    }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store'); // may carry the one-time claim code
      res
        .status(201)
        .json(
          await bookings.createForGuest(
            await guest(req),
            body(req),
            idemKey(req, true),
            requestMeta(req),
          ),
        );
    },
  );
  r.get('/guest/bookings', validate({ query: listQuery }), async (req, res) => {
    res.json(await bookings.listForGuest(await guest(req), query(req)));
  });
  r.get('/guest/bookings/:bookingId', bookingId, async (req, res) => {
    res.json({ data: await bookings.getForGuest(await guest(req), id(req)) });
  });
  r.post(
    '/guest/bookings/:bookingId/cancel',
    bookingId,
    validate({ body: z.object({ reason: reason.optional() }).strict() }),
    async (req, res) => {
      res.json(
        await bookings.cancelByGuest(
          await guest(req),
          id(req),
          body<{ reason?: string }>(req).reason ?? null,
          requestMeta(req),
        ),
      );
    },
  );

  r.post(
    '/guest/sessions/attach',
    validate({
      body: z
        .object({ claimCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid claim code') })
        .strict(),
    }),
    async (req, res) => {
      res.json({
        data: await persons.attachGuest(
          await guest(req),
          body<{ claimCode: string }>(req).claimCode,
          requestMeta(req),
        ),
      });
    },
  );
  r.post('/guest/claim-codes', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res
      .status(201)
      .json({ data: await persons.rotateClaimCode(await guest(req), requestMeta(req)) });
  });

  // ---------- clinic ----------
  r.post(
    '/clinic/bookings',
    auth,
    ctx,
    validate({
      body: z
        .object({
          branchId: idSchema,
          serviceId: idSchema,
          assignmentId: idSchema,
          startsAt: slotFields.startsAt,
          note: slotFields.note,
          patient: z.union([
            z.object({ patientProfileId: idSchema }).strict(),
            z
              .object({
                new: z
                  .object({
                    displayName: z.string().trim().min(2).max(150),
                    birthDate: date.nullable().optional(),
                    contactPhone: z.string().max(32).nullable().optional(),
                  })
                  .strict(),
              })
              .strict(),
          ]),
        })
        .strict(),
    }),
    async (req, res) => {
      const b = body<Parameters<BookingService['createByStaff']>[2]>(req);
      const patient =
        'new' in b.patient &&
        b.patient.new.contactPhone !== undefined &&
        b.patient.new.contactPhone !== null
          ? { new: { ...b.patient.new, contactPhone: phone(b.patient.new.contactPhone) } }
          : b.patient;
      res
        .status(201)
        .json(
          await bookings.createByStaff(
            principalOf(req),
            requireTenant(req),
            { ...b, patient },
            idemKey(req, true),
            requestMeta(req),
          ),
        );
    },
  );
  r.get(
    '/clinic/bookings',
    auth,
    ctx,
    validate({
      query: listQuery.extend({
        branchId: idSchema.optional(),
        assignmentId: idSchema.optional(),
        serviceId: idSchema.optional(),
        patientProfileId: idSchema.optional(),
        from: date.optional(),
        to: date.optional(),
      }),
    }),
    async (req, res) => {
      res.json(await bookings.listForClinic(principalOf(req), requireTenant(req), query(req)));
    },
  );
  r.get('/clinic/bookings/:bookingId', auth, ctx, bookingId, async (req, res) => {
    res.json({ data: await bookings.getForClinic(principalOf(req), requireTenant(req), id(req)) });
  });
  r.post('/clinic/bookings/:bookingId/confirm', auth, ctx, bookingId, async (req, res) => {
    res.json(
      await bookings.confirm(
        principalOf(req),
        requireTenant(req),
        id(req),
        idemKey(req, false),
        requestMeta(req),
      ),
    );
  });
  for (const [path, run] of [
    ['reject', bookings.reject.bind(bookings)],
    ['cancel', bookings.cancelByClinic.bind(bookings)],
  ] as const) {
    r.post(
      `/clinic/bookings/:bookingId/${path}`,
      auth,
      ctx,
      bookingId,
      validate({ body: z.object({ reason }).strict() }),
      async (req, res) => {
        res.json(
          await run(
            principalOf(req),
            requireTenant(req),
            id(req),
            body<{ reason: string }>(req).reason,
            requestMeta(req),
          ),
        );
      },
    );
  }
  r.get('/clinic/booking-settings', auth, ctx, async (req, res) => {
    res.json({ data: await deps.settings.get(principalOf(req), requireTenant(req)) });
  });
  r.put(
    '/clinic/booking-settings',
    auth,
    ctx,
    validate({ body: settingsPatch }),
    async (req, res) => {
      res.json({
        data: await deps.settings.update(
          principalOf(req),
          requireTenant(req),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  return r;
}
