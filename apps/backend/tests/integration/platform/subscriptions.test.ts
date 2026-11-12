import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_REQUEST_META } from '../../../src/shared/http/request-meta.js';
import { createHarness } from '../support/harness.js';
import { body, type LoggedIn } from '../support/fixtures.js';
import {
  addStaff,
  adminSession,
  as,
  code,
  createPlan,
  data,
  onboardClinic,
  PROBE,
  probeRoutes,
  type OnboardedClinic,
} from '../support/platform.js';

const h = createHarness({ extraRoutes: probeRoutes });
afterAll(() => h.close());

const DAY = 86_400_000;
let admin: LoggedIn;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
});

interface Sub {
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    planVersionId: string;
  };
  effective: { status: string; permitsNewOperations: boolean };
  planVersion: { version: number; monthlyPriceMinor: string };
}
const sub = async (c: OnboardedClinic) =>
  data<Sub>(await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic/subscription'));
const sweep = () => h.container.services.subscriptions.sweep(NO_REQUEST_META);
const probeNew = (c: OnboardedClinic) =>
  as(h, c.owner, { clinicId: c.clinicId }).get(`/test/probe/${PROBE.NEW_OPERATION}`);
/**
 * Advances the clock in steps of at most 20 days, refreshing the owner's tokens through the real
 * refresh flow each step (access tokens live 15 min, refresh tokens 30 days of inactivity).
 */
async function refreshed(s: LoggedIn): Promise<LoggedIn> {
  const res = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
  if (res.status !== 200) throw new Error(`refresh failed ${res.status}`);
  const pair = data<{ accessToken: string; refreshToken: string }>(res);
  return {
    ...s,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    bearer: `Bearer ${pair.accessToken}`,
  };
}

/** Also refreshes the (module-level) admin session. */
async function advance(c: OnboardedClinic, ms: number): Promise<OnboardedClinic> {
  let current = c;
  for (let left = ms; left > 0; left -= 20 * DAY) {
    h.clock.advance(Math.min(left, 20 * DAY));
    current = { ...current, owner: await refreshed(current.owner) };
    admin = await refreshed(admin);
  }
  return current;
}

describe('subscription plans', () => {
  it('creates plans and immutable versions; existing subscriptions keep their terms', async () => {
    const planId = await createPlan(h, admin, { trialDays: 7 });
    const c = await onboardClinic(h, admin, { planId });
    const v1 = (await sub(c)).subscription.planVersionId;
    const v2 = await as(h, admin).post(`/admin/plans/${planId}/versions`, {
      monthlyPriceMinor: 9900,
      annualPriceMinor: 99000,
      currency: 'USD',
      trialDays: 7,
      features: { marketplace_listing: true },
      limits: { max_branches: null, max_active_members: null },
    });
    expect(data<{ version: number }>(v2).version).toBe(2);
    expect((await sub(c)).subscription.planVersionId).toBe(v1);
    const detail = data<{ versions: { version: number }[] }>(
      await as(h, admin).get(`/admin/plans/${planId}`),
    );
    expect(detail.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(
      (
        await as(h, admin).post(`/admin/plans/${planId}/versions`, {
          monthlyPriceMinor: 1,
          annualPriceMinor: 1,
          currency: 'usd',
          trialDays: 0,
          features: {},
          limits: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(h, c.owner).post('/admin/plans', {
          code: 'sneaky',
          name: 'Sneaky',
          terms: {
            monthlyPriceMinor: 0,
            annualPriceMinor: 0,
            currency: 'USD',
            trialDays: 0,
            features: { marketplace_listing: true },
            limits: { max_branches: null, max_active_members: null },
          },
        })
      ).status,
    ).toBe(403);
    const pub = body<{ data: { id: string }[] }>(await h.http().get('/api/v1/plans'));
    expect(pub.data.map((p) => p.id)).toContain(planId);
    await as(h, admin).post(`/admin/plans/${planId}/deactivate`);
    expect(
      body<{ data: { id: string }[] }>(await h.http().get('/api/v1/plans')).data.map((p) => p.id),
    ).not.toContain(planId);
  });
});

describe('subscription lifecycle', () => {
  it('trial on approval → payment activates → renewal extends → plan change; complete history', async () => {
    const c = await onboardClinic(h, admin);
    expect((await sub(c)).subscription.status).toBe('TRIAL');
    const paid = data<{ status: string; currentPeriodEnd: string }>(
      await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/payments`, {
        reference: 'manual-001',
      }),
    );
    expect(paid.status).toBe('ACTIVE');
    const renewed = data<{ currentPeriodEnd: string; currentPeriodStart: string }>(
      await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/payments`, {}),
    );
    expect(renewed.currentPeriodStart).toBe(paid.currentPeriodEnd);
    const other = await createPlan(h, admin, { marketplace: false });
    expect(
      (
        await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/change-plan`, {
          planId: other,
          reason: 'Downgrade requested',
        })
      ).status,
    ).toBe(200);
    const history = body<{ data: { eventType: string; actorUserId: string | null }[] }>(
      await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic/subscription/history'),
    );
    expect(history.data.map((x) => x.eventType).reverse()).toEqual([
      'TRIAL_STARTED',
      'ACTIVATED',
      'RENEWED',
      'PLAN_CHANGED',
    ]);
    expect(history.data.every((x) => x.actorUserId === admin.userId)).toBe(true);
    const audit = await h.db.query(
      `SELECT id FROM audit_events WHERE target_type = 'SUBSCRIPTION' AND clinic_id = ?`,
      [c.clinicId],
    );
    expect(audit).toHaveLength(4);
  });

  it('sweep: trial end → EXPIRED; unpaid period → PAST_DUE → grace expiry → SUSPENDED', async () => {
    let c = await onboardClinic(h, admin);
    c = await advance(c, 15 * DAY);
    expect((await sub(c)).effective.status).toBe('EXPIRED'); // enforced before the sweep runs
    expect((await sweep()).changed).toBe(1);
    expect((await sub(c)).subscription.status).toBe('EXPIRED');

    await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/payments`, {});
    c = await advance(c, 32 * DAY);
    await sweep();
    expect((await sub(c)).subscription.status).toBe('PAST_DUE');
    expect((await probeNew(c)).status).toBe(200); // within the grace period
    c = await advance(c, 3 * DAY);
    await sweep();
    expect((await sub(c)).subscription.status).toBe('SUSPENDED');
    const events = body<{ data: { eventType: string }[] }>(
      await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic/subscription/history'),
    ).data.map((x) => x.eventType);
    expect(events).toEqual(
      expect.arrayContaining(['TRIAL_ENDED', 'MARKED_PAST_DUE', 'GRACE_EXPIRED']),
    );
  });

  it('enforcement is centralized: after grace, new operations are blocked on every path; reads and data remain', async () => {
    let c = await onboardClinic(h, admin, { paid: true });
    await addStaff(h, c.owner, c.clinicId, 'DOCTOR');
    c = await advance(c, 35 * DAY); // past period end + 3-day grace; sweep NOT run
    expect(code(await probeNew(c))).toBe('SUBSCRIPTION_INACTIVE');
    expect(
      code(
        await as(h, c.owner, { clinicId: c.clinicId }).post('/clinic/branches', {
          name: 'Blocked',
          timeZone: 'UTC',
        }),
      ),
    ).toBe('SUBSCRIPTION_INACTIVE');
    expect(
      code(
        await as(h, c.owner, { clinicId: c.clinicId }).post('/clinic/invitations', {
          phone: '+12025550133',
          role: 'DOCTOR',
          branchScope: 'ALL',
          branchIds: [],
        }),
      ),
    ).toBe('SUBSCRIPTION_INACTIVE');
    expect(
      (await as(h, c.owner, { clinicId: c.clinicId }).get(`/test/probe/${PROBE.READ}`)).status,
    ).toBe(200);
    expect((await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic/branches')).status).toBe(
      200,
    );
    // Not confused with operational suspension; memberships untouched.
    expect(
      data<{ clinic: { operationalStatus: string } }>(
        await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic'),
      ).clinic.operationalStatus,
    ).toBe('ACTIVE');
    expect(
      await h.db.query(
        `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND status = 'ACTIVE'`,
        [c.clinicId],
      ),
    ).toHaveLength(2);
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/payments`, {});
    expect((await probeNew(c)).status).toBe(200);
  });

  it('grace period is configurable by Super Admin (platform default and per clinic)', async () => {
    expect(
      data<Record<string, number>>(await as(h, admin).get('/admin/settings'))[
        'subscription.grace_period_days'
      ],
    ).toBe(3);
    expect(
      (await as(h, admin).patch('/admin/settings', { 'subscription.grace_period_days': 10 }))
        .status,
    ).toBe(200);
    let c = await onboardClinic(h, admin, { paid: true });
    c = await advance(c, 35 * DAY);
    expect((await probeNew(c)).status).toBe(200);
    await as(h, admin).put(`/admin/clinics/${c.clinicId}/subscription/grace-period`, {
      days: 0,
      reason: 'Repeated late payments',
    });
    expect(code(await probeNew(c))).toBe('SUBSCRIPTION_INACTIVE');
    const audit = await h.db.query(
      `SELECT id FROM audit_events WHERE action = 'PLATFORM_SETTINGS_CHANGED'`,
    );
    expect(audit).toHaveLength(1);
    expect(
      (await as(h, c.owner).patch('/admin/settings', { 'subscription.grace_period_days': 60 }))
        .status,
    ).toBe(403);
  });

  it('admin suspension, reactivation and expiry follow the state machine', async () => {
    const c = await onboardClinic(h, admin, { paid: true });
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/suspend`, {
          reason: 'Chargeback',
        }),
      ).status,
    ).toBe('SUSPENDED');
    expect(code(await probeNew(c))).toBe('SUBSCRIPTION_INACTIVE');
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/reactivate`, {
          reason: 'Resolved',
        }),
      ).status,
    ).toBe('ACTIVE');
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/expire`, {
          reason: 'Contract ended',
        }),
      ).status,
    ).toBe('EXPIRED');
    expect(
      code(
        await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/suspend`, {
          reason: 'again',
        }),
      ),
    ).toBe('INVALID_TRANSITION');
    expect(
      (
        await as(h, c.owner, { clinicId: c.clinicId }).post(
          `/admin/clinics/${c.clinicId}/subscription/payments`,
          {},
        )
      ).status,
    ).toBe(403);
  });

  // Task 03.2 (ADR-038): a plan with trial_days = 0 starts PAST_DUE at approval.
  it('zero-day trial: approval starts PAST_DUE with no trial; only the grace period permits operations; payment activates', async () => {
    const planId = await createPlan(h, admin, { trialDays: 0 });
    let c = await onboardClinic(h, admin, { planId });
    const initial = await sub(c);
    expect(initial.subscription).toMatchObject({
      status: 'PAST_DUE',
      trialEndsAt: null,
      currentPeriodEnd: null,
    });
    expect(initial.effective).toMatchObject({ status: 'PAST_DUE', permitsNewOperations: true });
    const events = body<{ data: { eventType: string }[] }>(
      await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic/subscription/history'),
    ).data.map((x) => x.eventType);
    expect(events).toEqual(['CREATED']); // never TRIAL_STARTED

    // Inside the grace period (default 3 days) new operations are allowed, and the subscription
    // criterion of Marketplace eligibility is met (other criteria still apply) …
    expect((await probeNew(c)).status).toBe(200);
    expect(
      data<{ eligibility: { reasons: string[] } }>(
        await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic/marketplace'),
      ).eligibility.reasons,
    ).not.toContain('SUBSCRIPTION_NOT_ELIGIBLE');
    // … and blocked once it ends, even without the sweep; reads remain.
    c = await advance(c, 3 * DAY + 60_000);
    expect(code(await probeNew(c))).toBe('SUBSCRIPTION_INACTIVE');
    expect((await sub(c)).effective).toMatchObject({
      status: 'SUSPENDED',
      permitsNewOperations: false,
    });
    expect(
      (await as(h, c.owner, { clinicId: c.clinicId }).get(`/test/probe/${PROBE.READ}`)).status,
    ).toBe(200);
    expect(
      data<{ eligibility: { reasons: string[] } }>(
        await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic/marketplace'),
      ).eligibility.reasons,
    ).toContain('SUBSCRIPTION_NOT_ELIGIBLE');

    // Recording a payment (Super Admin) activates the subscription for one billing cycle.
    const paid = await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/payments`, {
      reference: 'INV-0001',
    });
    expect(paid.status).toBeLessThan(300);
    const active = await sub(c);
    expect(active.subscription.status).toBe('ACTIVE');
    expect(new Date(active.subscription.currentPeriodEnd ?? 0).getTime()).toBeGreaterThan(
      h.clock().getTime() + 27 * DAY,
    );
    expect((await probeNew(c)).status).toBe(200);
    // An owner cannot record a payment.
    expect(
      (await as(h, c.owner).post(`/admin/clinics/${c.clinicId}/subscription/payments`, {})).status,
    ).toBe(403);

    // A grace override of 0 removes the unpaid window entirely for a zero-trial clinic.
    const strict = await onboardClinic(h, admin, { planId });
    expect((await probeNew(strict)).status).toBe(200);
    expect(
      (
        await as(h, admin).put(`/admin/clinics/${strict.clinicId}/subscription/grace-period`, {
          days: 0,
          reason: 'Payment required before operating',
        })
      ).status,
    ).toBe(200);
    expect(code(await probeNew(strict))).toBe('SUBSCRIPTION_INACTIVE');
  });
});
