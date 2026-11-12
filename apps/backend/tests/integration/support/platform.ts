import { Router } from 'express';
import type { Container } from '../../../src/container.js';
import {
  clinicContext,
  isPermission,
  requirePermission,
} from '../../../src/modules/access/index.js';
import { createVerifiedClinicScope } from '../../../src/modules/access/tenancy/clinic-scope-factory.js';
import type { Harness } from './harness.js';
import {
  body,
  createUser,
  grantGlobalRole,
  login,
  testDevice,
  testPhone,
  type LoggedIn,
} from './fixtures.js';
import { enrollMfa } from './mfa.js';

/** Synthetic documents (never real patient or identity data). */
export const PDF = Buffer.from('%PDF-1.4\n% synthetic test document\n');
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A SUPER_ADMIN with an MFA-verified session. */
export async function adminSession(h: Harness): Promise<LoggedIn> {
  const user = await createUser(h.db);
  await grantGlobalRole(h.db, user.id, 'SUPER_ADMIN');
  const s = await login(h, user.phone, { device: testDevice('ADMIN_WEB') });
  await enrollMfa(h, s);
  return s;
}

export async function userSession(
  h: Harness,
  phone = testPhone(),
  appType = 'CLINIC_WEB',
): Promise<LoggedIn> {
  return login(h, phone, { device: testDevice(appType) });
}

/** Authenticated request helpers with optional clinic/branch context. */
export function as(h: Harness, s: LoggedIn, ctx: { clinicId?: string; branchId?: string } = {}) {
  const prep = <T extends { set: (k: string, v: string) => T }>(r: T): T => {
    let x = r.set('Authorization', s.bearer);
    if (ctx.clinicId !== undefined) x = x.set('X-Clinic-Id', ctx.clinicId);
    if (ctx.branchId !== undefined) x = x.set('X-Branch-Id', ctx.branchId);
    return x;
  };
  return {
    get: (path: string) => prep(h.http().get(`/api/v1${path}`)),
    post: (path: string, payload: object = {}) =>
      prep(h.http().post(`/api/v1${path}`)).send(payload),
    patch: (path: string, payload: object) => prep(h.http().patch(`/api/v1${path}`)).send(payload),
    put: (path: string, payload: object) => prep(h.http().put(`/api/v1${path}`)).send(payload),
    delete: (path: string) => prep(h.http().delete(`/api/v1${path}`)),
    upload: (path: string, type: string, data = PDF, contentType = 'application/pdf') =>
      prep(h.http().post(`/api/v1${path}?type=${type}&filename=doc.pdf`))
        .set('Content-Type', contentType)
        .send(data),
  };
}

export const code = (res: { body: unknown }) => body<{ error?: { code: string } }>(res).error?.code;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- deliberate typed cast for test assertions
export const data = <T = Record<string, unknown>>(res: { body: unknown }) =>
  body<{ data: T }>(res).data;

export async function createPlan(
  h: Harness,
  admin: LoggedIn,
  terms: {
    trialDays?: number;
    marketplace?: boolean;
    maxBranches?: number | null;
    maxMembers?: number | null;
    code?: string;
  } = {},
): Promise<string> {
  const res = await as(h, admin).post('/admin/plans', {
    code: terms.code ?? `plan_${Math.random().toString(36).slice(2, 8)}`,
    name: 'Synthetic Plan',
    terms: {
      monthlyPriceMinor: 4900,
      annualPriceMinor: 49000,
      currency: 'USD',
      trialDays: terms.trialDays ?? 14,
      features: { marketplace_listing: terms.marketplace ?? true },
      limits: {
        max_branches: terms.maxBranches ?? null,
        max_active_members: terms.maxMembers ?? null,
      },
    },
  });
  if (res.status !== 201)
    throw new Error(`plan create failed ${res.status} ${JSON.stringify(res.body)}`);
  return data<{ id: string }>(res).id;
}

export const COMPLETE_REGISTRATION = {
  clinicName: 'Synthetic Health Clinic',
  clinicType: 'GENERAL',
  description: 'Synthetic clinic for automated tests',
  contactPhone: '+12025550188',
  contactEmail: 'clinic@example.test',
  addressLine1: '1 Test Street',
  city: 'Testville',
  countryCode: 'US',
  latitude: 38.9,
  longitude: -77.03,
  legalName: 'Synthetic Health LLC',
  businessRegistrationNo: 'TEST-123',
};

/** Owner registers, uploads a document and submits; returns the registration id. */
export async function submitRegistration(
  h: Harness,
  owner: LoggedIn,
  fields: object = COMPLETE_REGISTRATION,
): Promise<string> {
  const created = await as(h, owner).post('/registrations', fields);
  if (created.status !== 201)
    throw new Error(`registration failed ${created.status} ${JSON.stringify(created.body)}`);
  const id = data<{ id: string }>(created).id;
  const up = await as(h, owner).upload(`/registrations/${id}/documents`, 'BUSINESS_LICENSE');
  if (up.status !== 201) throw new Error(`upload failed ${up.status} ${JSON.stringify(up.body)}`);
  const submitted = await as(h, owner).post(`/registrations/${id}/submit`);
  if (submitted.status !== 200)
    throw new Error(`submit failed ${submitted.status} ${JSON.stringify(submitted.body)}`);
  return id;
}

export interface OnboardedClinic {
  readonly clinicId: string;
  readonly branchId: string;
  readonly registrationId: string;
  readonly owner: LoggedIn;
  readonly planId: string;
}

/** Full API onboarding: owner registration → admin review → approval (clinic + branch + owner + subscription). */
export async function onboardClinic(
  h: Harness,
  admin: LoggedIn,
  options: { owner?: LoggedIn; planId?: string; paid?: boolean } = {},
): Promise<OnboardedClinic> {
  const owner = options.owner ?? (await userSession(h));
  const planId = options.planId ?? (await createPlan(h, admin));
  const registrationId = await submitRegistration(h, owner);
  const review = await as(h, admin).post(`/admin/registrations/${registrationId}/start-review`);
  if (review.status !== 200)
    throw new Error(`start-review failed ${review.status} ${JSON.stringify(review.body)}`);
  const approved = await as(h, admin).post(`/admin/registrations/${registrationId}/approve`, {
    planId,
    billingCycle: 'MONTHLY',
  });
  if (approved.status !== 200)
    throw new Error(`approve failed ${approved.status} ${JSON.stringify(approved.body)}`);
  const result = data<{ clinicId: string; branchId: string }>(approved);
  if (options.paid === true)
    await as(h, admin).post(`/admin/clinics/${result.clinicId}/subscription/payments`, {});
  return { clinicId: result.clinicId, branchId: result.branchId, registrationId, owner, planId };
}

/** Invite + accept via the API; returns the new member's session and membership id. */
export async function addStaff(
  h: Harness,
  inviter: LoggedIn,
  clinicId: string,
  role: 'CLINIC_MANAGER' | 'DOCTOR' | 'RECEPTIONIST',
  options: {
    branchScope?: 'ALL' | 'ASSIGNED';
    branchIds?: string[];
    member?: { session: LoggedIn; phone: string };
  } = {},
): Promise<{ session: LoggedIn; phone: string; membershipId: string }> {
  const phone = options.member?.phone ?? testPhone();
  const invited = await as(h, inviter, { clinicId }).post('/clinic/invitations', {
    phone,
    role,
    branchScope: options.branchScope ?? 'ALL',
    branchIds: options.branchIds ?? [],
  });
  if (invited.status !== 201)
    throw new Error(`invite failed ${invited.status} ${JSON.stringify(invited.body)}`);
  const session = options.member?.session ?? (await userSession(h, phone));
  const accepted = await as(h, session).post('/invitations/accept', {
    token: data<{ token: string }>(invited).token,
  });
  if (accepted.status !== 200)
    throw new Error(`accept failed ${accepted.status} ${JSON.stringify(accepted.body)}`);
  return { session, phone, membershipId: data<{ membershipId: string }>(accepted).membershipId };
}

export { createVerifiedClinicScope };

/**
 * Test-only probes: `GET /api/v1/test/probe/<permission>` runs the REAL authenticate →
 * clinicContext → requirePermission chain, standing in for future business endpoints
 * (bookings, records…) to prove enforcement cannot be bypassed by calling APIs directly.
 */
export function probeRoutes(c: Container): Router {
  const r = Router();
  r.get(
    '/probe/:permission',
    c.authenticate,
    clinicContext(c.services.resolver),
    async (req, res, next) => {
      const permission = (req.params as { permission: string }).permission;
      if (!isPermission(permission)) {
        res.status(400).end();
        return;
      }
      await requirePermission(c.services.authz, permission)(req, res, next);
    },
    (_req, res) => {
      res.json({ data: { allowed: true } });
    },
  );
  return r;
}

/** Permission per category used by probes. */
export const PROBE = {
  READ: 'clinic.patients.view',
  CONTINUITY_OF_CARE: 'clinic.medical_records.view',
  NEW_OPERATION: 'clinic.bookings.manage',
  ADMINISTRATION: 'clinic.services.manage',
} as const;
