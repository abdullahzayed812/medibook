import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
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

let admin: LoggedIn;
let a: OnboardedClinic;
let b: OnboardedClinic;

beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  a = await onboardClinic(h, admin, { paid: true });
  b = await onboardClinic(h, admin, { paid: true });
});

const branch = {
  name: 'Riverside',
  timeZone: 'Asia/Baghdad',
  addressLine1: '2 River Rd',
  city: 'Testville',
  countryCode: 'US',
  latitude: 10.5,
  longitude: 20.25,
  contactPhone: '+12025550190',
};

describe('branch management', () => {
  it('creates, reads, updates, deactivates and reactivates branches with audit', async () => {
    const api = as(h, a.owner, { clinicId: a.clinicId });
    const created = await api.post('/clinic/branches', branch);
    expect(created.status).toBe(201);
    const id = data<{ id: string; timeZone: string; status: string }>(created).id;
    expect(data<{ timeZone: string; status: string; latitude: number }>(created)).toMatchObject({
      timeZone: 'Asia/Baghdad',
      status: 'ACTIVE',
      latitude: 10.5,
    });
    expect(
      data<{ name: string }>(await api.patch(`/clinic/branches/${id}`, { name: 'Riverside East' }))
        .name,
    ).toBe('Riverside East');
    expect(
      data<{ status: string }>(await api.post(`/clinic/branches/${id}/deactivate`)).status,
    ).toBe('INACTIVE');
    expect(data<{ status: string }>(await api.post(`/clinic/branches/${id}/activate`)).status).toBe(
      'ACTIVE',
    );
    expect(data<unknown[]>(await api.get('/clinic/branches'))).toHaveLength(2);
    expect(
      (await api.post('/clinic/branches', { ...branch, timeZone: 'Mars/Olympus' })).status,
    ).toBe(400);
    const audit = await h.db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target_type = 'BRANCH' ORDER BY id`,
    );
    expect(audit.map((x) => x.action)).toEqual([
      'BRANCH_CREATED',
      'BRANCH_UPDATED',
      'BRANCH_STATUS_CHANGED',
      'BRANCH_STATUS_CHANGED',
    ]);
  });

  it('managers cannot manage branches; branch-assigned staff only see their branches', async () => {
    const api = as(h, a.owner, { clinicId: a.clinicId });
    const second = data<{ id: string }>(await api.post('/clinic/branches', branch)).id;
    const manager = await addStaff(h, a.owner, a.clinicId, 'CLINIC_MANAGER');
    expect(
      (await as(h, manager.session, { clinicId: a.clinicId }).post('/clinic/branches', branch))
        .status,
    ).toBe(403);
    const doctor = await addStaff(h, a.owner, a.clinicId, 'DOCTOR', {
      branchScope: 'ASSIGNED',
      branchIds: [second],
    });
    const docApi = as(h, doctor.session, { clinicId: a.clinicId });
    expect(data<{ id: string }[]>(await docApi.get('/clinic/branches')).map((x) => x.id)).toEqual([
      second,
    ]);
    expect((await docApi.get(`/clinic/branches/${a.branchId}`)).status).toBe(404);
    // Branch assignment never grants operational access to another branch.
    expect(
      (
        await as(h, doctor.session, { clinicId: a.clinicId, branchId: second }).get(
          `/test/probe/${PROBE.CONTINUITY_OF_CARE}`,
        )
      ).status,
    ).toBe(200);
    expect(
      code(
        await as(h, doctor.session, { clinicId: a.clinicId, branchId: a.branchId }).get(
          `/test/probe/${PROBE.CONTINUITY_OF_CARE}`,
        ),
      ),
    ).toBe('BRANCH_ACCESS_DENIED');
  });

  it('an inactive branch blocks new operations in that branch context only', async () => {
    const api = as(h, a.owner, { clinicId: a.clinicId });
    const second = data<{ id: string }>(await api.post('/clinic/branches', branch)).id;
    await api.post(`/clinic/branches/${second}/deactivate`);
    expect(
      code(
        await as(h, a.owner, { clinicId: a.clinicId, branchId: second }).get(
          `/test/probe/${PROBE.NEW_OPERATION}`,
        ),
      ),
    ).toBe('BRANCH_INACTIVE');
    expect(
      (
        await as(h, a.owner, { clinicId: a.clinicId, branchId: second }).get(
          `/test/probe/${PROBE.READ}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await as(h, a.owner, { clinicId: a.clinicId, branchId: a.branchId }).get(
          `/test/probe/${PROBE.NEW_OPERATION}`,
        )
      ).status,
    ).toBe(200);
  });

  it('enforces the plan branch limit', async () => {
    const planId = await createPlan(h, admin, { maxBranches: 1 });
    const c = await onboardClinic(h, admin, { planId });
    expect(
      code(await as(h, c.owner, { clinicId: c.clinicId }).post('/clinic/branches', branch)),
    ).toBe('PLAN_LIMIT_REACHED');
  });
});

describe('platform tenant isolation (Clinic A vs Clinic B)', () => {
  it('Clinic A cannot read or modify Clinic B branches, even with manipulated ids', async () => {
    const asA = as(h, a.owner, { clinicId: a.clinicId });
    expect((await asA.get(`/clinic/branches/${b.branchId}`)).status).toBe(404);
    expect((await asA.patch(`/clinic/branches/${b.branchId}`, { name: 'Hijacked' })).status).toBe(
      404,
    );
    expect((await asA.post(`/clinic/branches/${b.branchId}/deactivate`)).status).toBe(404);
    const [row] = await h.db.query<{ name: string; status: string }>(
      'SELECT name, status FROM clinic_branches WHERE id = ?',
      [b.branchId],
    );
    expect(row).toMatchObject({ name: 'Synthetic Health Clinic', status: 'ACTIVE' });
    // Switching the header to B is refused (no membership there).
    expect(code(await as(h, a.owner, { clinicId: b.clinicId }).get('/clinic/branches'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect(
      code(await as(h, a.owner, { clinicId: a.clinicId, branchId: b.branchId }).get('/clinic')),
    ).toBe('BRANCH_ACCESS_DENIED');
  });

  it('Clinic A cannot manage Clinic B memberships, invitations, closure requests or transfers', async () => {
    const staffB = await addStaff(h, b.owner, b.clinicId, 'RECEPTIONIST');
    const asA = as(h, a.owner, { clinicId: a.clinicId });
    expect(
      (
        await asA.patch(`/clinic/members/${staffB.membershipId}/status`, {
          status: 'TERMINATED',
          reason: 'hostile',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await asA.put(`/clinic/members/${staffB.membershipId}/branches`, {
          branchScope: 'ALL',
          branchIds: [],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await asA.post('/clinic/invitations', {
          phone: '+12025550181',
          role: 'DOCTOR',
          branchScope: 'ASSIGNED',
          branchIds: [b.branchId],
        })
      ).status,
    ).toBe(400);
    const invB = data<{ invitation: { id: string } }>(
      await as(h, b.owner, { clinicId: b.clinicId }).post('/clinic/invitations', {
        phone: '+12025550182',
        role: 'DOCTOR',
        branchScope: 'ALL',
        branchIds: [],
      }),
    ).invitation.id;
    expect((await asA.post(`/clinic/invitations/${invB}/revoke`)).status).toBe(404);
    const closureB = data<{ id: string }>(
      await as(h, b.owner, { clinicId: b.clinicId }).post('/clinic/closure-requests', {
        reason: 'B wants to close now',
      }),
    ).id;
    expect((await asA.get(`/clinic/closure-requests/${closureB}`)).status).toBe(404);
    expect((await asA.post(`/clinic/closure-requests/${closureB}/cancel`)).status).toBe(404);
    expect(data<unknown[]>(await asA.get('/clinic/invitations'))).toHaveLength(0);
    const members = await h.db.query<{ status: string }>(
      'SELECT status FROM clinic_memberships WHERE id = ?',
      [staffB.membershipId],
    );
    expect(members[0]?.status).toBe('ACTIVE');
  });

  it('a user removed from one clinic keeps their other clinic memberships', async () => {
    const shared = await addStaff(h, a.owner, a.clinicId, 'DOCTOR');
    await addStaff(h, b.owner, b.clinicId, 'DOCTOR', { member: shared });
    expect(
      (
        await as(h, a.owner, { clinicId: a.clinicId }).patch(
          `/clinic/members/${shared.membershipId}/status`,
          { status: 'TERMINATED', reason: 'contract ended' },
        )
      ).status,
    ).toBe(204);
    expect(code(await as(h, shared.session, { clinicId: a.clinicId }).get('/clinic'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect((await as(h, shared.session, { clinicId: b.clinicId }).get('/clinic')).status).toBe(200);
    expect((await as(h, shared.session).get('/me')).status).toBe(200);
  });
});
