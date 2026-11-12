import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import {
  createUser,
  grantGlobalRole,
  login,
  testDevice,
  type LoggedIn,
} from '../support/fixtures.js';
import { enrollMfa } from '../support/mfa.js';
import {
  addStaff,
  adminSession,
  as,
  code,
  data,
  onboardClinic,
  PROBE,
  probeRoutes,
  type OnboardedClinic,
} from '../support/platform.js';

const h = createHarness({ extraRoutes: probeRoutes });
afterAll(() => h.close());

let admin: LoggedIn;
let clinic: OnboardedClinic;
let doctor: { session: LoggedIn; membershipId: string };

beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  clinic = await onboardClinic(h, admin, { paid: true });
  doctor = await addStaff(h, clinic.owner, clinic.clinicId, 'DOCTOR');
});

const probe = (s: LoggedIn, permission: string) =>
  as(h, s, { clinicId: clinic.clinicId }).get(`/test/probe/${permission}`);
const ownerApi = () => as(h, clinic.owner, { clinicId: clinic.clinicId });
const branchBody = { name: 'New Branch', timeZone: 'UTC' };

describe('clinic suspension', () => {
  it('FULL: blocks normal operations but keeps clinic info and lifecycle; data and memberships are kept', async () => {
    expect((await probe(doctor.session, PROBE.CONTINUITY_OF_CARE)).status).toBe(200);
    const res = await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
      scope: 'FULL',
      reason: 'Regulatory investigation',
    });
    expect(res.status).toBe(204);

    expect(code(await probe(doctor.session, PROBE.CONTINUITY_OF_CARE))).toBe('CLINIC_SUSPENDED');
    expect(code(await probe(doctor.session, PROBE.READ))).toBe('CLINIC_SUSPENDED');
    expect(code(await probe(clinic.owner, PROBE.NEW_OPERATION))).toBe('CLINIC_SUSPENDED');
    expect(code(await ownerApi().post('/clinic/branches', branchBody))).toBe('CLINIC_SUSPENDED');
    expect((await ownerApi().get('/clinic')).status).toBe(200);
    expect((await ownerApi().get('/clinic/closure-requests')).status).toBe(200);

    const members = await h.db.query(
      `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND status = 'ACTIVE'`,
      [clinic.clinicId],
    );
    expect(members).toHaveLength(2);
    const suspension = data<{ suspension: { reason: string; suspendedByUserId: string } }>(
      await as(h, admin).get(`/admin/clinics/${clinic.clinicId}`),
    ).suspension;
    expect(suspension).toMatchObject({
      reason: 'Regulatory investigation',
      suspendedByUserId: admin.userId,
    });
  });

  it('FULL: an explicit, time-limited access exception restores continuity of care for that user only', async () => {
    const receptionist = await addStaff(h, clinic.owner, clinic.clinicId, 'RECEPTIONIST');
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
      scope: 'FULL',
      reason: 'Investigation',
    });
    const expiresAt = new Date(h.clock().getTime() + 10 * 60_000).toISOString();
    const granted = await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/access-exceptions`, {
      userId: doctor.session.userId,
      reason: 'Ongoing treatment of admitted patients',
      expiresAt,
    });
    expect(granted.status).toBe(201);

    expect((await probe(doctor.session, PROBE.CONTINUITY_OF_CARE)).status).toBe(200);
    // Receptionist holds bookings.manage but has no exception: still suspended.
    expect(code(await probe(receptionist.session, PROBE.NEW_OPERATION))).toBe('CLINIC_SUSPENDED');
    expect(code(await probe(doctor.session, PROBE.ADMINISTRATION))).toBe('FORBIDDEN'); // role never had it
    expect(code(await probe(receptionist.session, PROBE.READ))).toBe('CLINIC_SUSPENDED');

    h.clock.advance(11 * 60_000); // past the exception, still inside the access-token lifetime
    expect(code(await probe(doctor.session, PROBE.CONTINUITY_OF_CARE))).toBe('CLINIC_SUSPENDED');
    const audit = await h.db.query(
      `SELECT id FROM audit_events WHERE action = 'ACCESS_EXCEPTION_GRANTED'`,
    );
    expect(audit).toHaveLength(1);
  });

  it('access exceptions are bounded, member-only and FULL-suspension-only', async () => {
    const outsider = await adminSession(h);
    const expiresAt = new Date(h.clock().getTime() + 3_600_000).toISOString();
    expect(
      (
        await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/access-exceptions`, {
          userId: doctor.session.userId,
          reason: 'x reason',
          expiresAt,
        })
      ).status,
    ).toBe(409);
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
      scope: 'FULL',
      reason: 'Investigation',
    });
    expect(
      (
        await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/access-exceptions`, {
          userId: outsider.userId,
          reason: 'no membership',
          expiresAt,
        })
      ).status,
    ).toBe(409);
    const tooLong = new Date(h.clock().getTime() + 100 * 3_600_000).toISOString();
    expect(
      (
        await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/access-exceptions`, {
          userId: doctor.session.userId,
          reason: 'too long',
          expiresAt: tooLong,
        })
      ).status,
    ).toBe(400);
  });

  it('NEW_OPERATIONS: only new operational transactions are blocked', async () => {
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
      scope: 'NEW_OPERATIONS',
      reason: 'Unpaid fines',
    });
    expect(code(await probe(clinic.owner, PROBE.NEW_OPERATION))).toBe('CLINIC_SUSPENDED');
    expect((await probe(doctor.session, PROBE.CONTINUITY_OF_CARE)).status).toBe(200);
    expect((await ownerApi().post('/clinic/branches', branchBody)).status).toBe(201);
  });

  // Task 03.2 (ADR-026): exception lifecycle and authorization.
  it('access exceptions: revocation applies to the next request, an exception never outlives its suspension, no self-grant', async () => {
    const suspend = () =>
      as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
        scope: 'FULL',
        reason: 'Investigation',
      });
    const grant = (by: LoggedIn, userId: string) =>
      as(h, by).post(`/admin/clinics/${clinic.clinicId}/access-exceptions`, {
        userId,
        reason: 'Ongoing treatment of admitted patients',
        expiresAt: new Date(h.clock().getTime() + 3_600_000).toISOString(),
      });
    await suspend();
    const granted = await grant(admin, doctor.session.userId);
    expect(granted.status).toBe(201);
    expect((await probe(doctor.session, PROBE.READ)).status).toBe(200);

    // Revocation takes effect on the very next request, and is audited.
    const id = data<{ id: string }>(granted).id;
    expect(
      (
        await as(h, admin).post(
          `/admin/clinics/${clinic.clinicId}/access-exceptions/${id}/revoke`,
          {},
        )
      ).status,
    ).toBe(204);
    expect(code(await probe(doctor.session, PROBE.READ))).toBe('CLINIC_SUSPENDED');
    expect(
      await h.db.query(`SELECT id FROM audit_events WHERE action = 'ACCESS_EXCEPTION_REVOKED'`),
    ).toHaveLength(1);

    // An exception belongs to one suspension: after reinstatement and a new suspension it is void.
    expect((await grant(admin, doctor.session.userId)).status).toBe(201);
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/reinstate`, { reason: 'Cleared' });
    await suspend();
    expect(code(await probe(doctor.session, PROBE.CONTINUITY_OF_CARE))).toBe('CLINIC_SUSPENDED');

    // A Super Admin who is also a member cannot lift the suspension for themselves.
    const memberAdmin = await createUser(h.db);
    await grantGlobalRole(h.db, memberAdmin.id, 'SUPER_ADMIN');
    const memberAdminSession = await login(h, memberAdmin.phone, {
      device: testDevice('ADMIN_WEB'),
    });
    await enrollMfa(h, memberAdminSession);
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/reinstate`, { reason: 'Cleared' });
    await addStaff(h, clinic.owner, clinic.clinicId, 'DOCTOR', {
      member: { session: memberAdminSession, phone: memberAdmin.phone },
    });
    await suspend();
    expect(code(await grant(memberAdminSession, memberAdmin.id))).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await grant(admin, memberAdmin.id)).status).toBe(201);
  });

  it('NEW_OPERATIONS: administration, reads and care continue; exceptions do not apply; statuses stay independent', async () => {
    const statuses = async () => {
      const [row] = await h.db.query<{ op: string; sub: string; reg: string }>(
        `SELECT c.operational_status op, s.status sub, r.status reg FROM clinics c
           JOIN clinic_subscriptions s ON s.clinic_id = c.id
           JOIN clinic_registration_requests r ON r.clinic_id = c.id WHERE c.id = ?`,
        [clinic.clinicId],
      );
      return row;
    };
    expect(await statuses()).toEqual({ op: 'ACTIVE', sub: 'ACTIVE', reg: 'APPROVED' });
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
      scope: 'NEW_OPERATIONS',
      reason: 'Unpaid fines',
    });
    expect(await statuses()).toEqual({ op: 'SUSPENDED', sub: 'ACTIVE', reg: 'APPROVED' });
    expect((await probe(clinic.owner, PROBE.ADMINISTRATION)).status).toBe(200);
    expect((await probe(doctor.session, PROBE.READ)).status).toBe(200);
    expect(code(await probe(clinic.owner, PROBE.NEW_OPERATION))).toBe('CLINIC_SUSPENDED');
    expect(
      (
        await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/access-exceptions`, {
          userId: doctor.session.userId,
          reason: 'not applicable',
          expiresAt: new Date(h.clock().getTime() + 3_600_000).toISOString(),
        })
      ).status,
    ).toBe(409);
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/reinstate`, { reason: 'Paid' });
    expect(await statuses()).toEqual({ op: 'ACTIVE', sub: 'ACTIVE', reg: 'APPROVED' });
  });

  it('formal reinstatement restores operations and keeps suspension history', async () => {
    await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
      scope: 'FULL',
      reason: 'Investigation',
    });
    expect(
      (
        await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
          scope: 'FULL',
          reason: 'again',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await as(h, admin).post(`/admin/clinics/${clinic.clinicId}/reinstate`, {
          reason: 'Investigation closed',
        })
      ).status,
    ).toBe(204);
    expect((await probe(clinic.owner, PROBE.NEW_OPERATION)).status).toBe(200);
    const history = data<{ endedAt: string | null; endReason: string | null }[]>(
      await as(h, admin).get(`/admin/clinics/${clinic.clinicId}/suspensions`),
    );
    expect(history).toEqual([expect.objectContaining({ endReason: 'Investigation closed' })]);
    const lifecycle = data<{ lifecycleHistory: { to_status: string }[] }>(
      await as(h, admin).get(`/admin/clinics/${clinic.clinicId}`),
    ).lifecycleHistory;
    expect(lifecycle.map((x) => x.to_status)).toEqual(['SUSPENDED', 'ACTIVE']);
  });

  it('only MFA-verified super admins can suspend; clinic owners cannot', async () => {
    expect(
      (
        await as(h, clinic.owner).post(`/admin/clinics/${clinic.clinicId}/suspend`, {
          scope: 'FULL',
          reason: 'self suspend',
        })
      ).status,
    ).toBe(403);
  });
});

describe('clinic closure', () => {
  async function approvedClosure(): Promise<string> {
    const requested = await ownerApi().post('/clinic/closure-requests', {
      reason: 'Retirement of the owner, closing permanently',
    });
    expect(requested.status).toBe(201);
    const id = data<{ id: string }>(requested).id;
    expect(
      (
        await as(h, admin).post(`/admin/closure-requests/${id}/approve`, {
          reason: 'Plan reviewed',
        })
      ).status,
    ).toBe(204);
    return id;
  }

  it('request → approve → CLOSING with required actions → blocked completion → resolve/waive → CLOSED, data retained', async () => {
    const pendingInvite = await ownerApi().post('/clinic/invitations', {
      phone: '+12025550177',
      role: 'RECEPTIONIST',
      branchScope: 'ALL',
      branchIds: [],
    });
    expect(pendingInvite.status).toBe(201);
    const id = await approvedClosure();

    expect(
      data<{ clinic: { operationalStatus: string } }>(await ownerApi().get('/clinic')).clinic
        .operationalStatus,
    ).toBe('CLOSING');
    expect(code(await probe(clinic.owner, PROBE.NEW_OPERATION))).toBe('CLINIC_CLOSING');
    expect((await probe(doctor.session, PROBE.CONTINUITY_OF_CARE)).status).toBe(200);
    const [invite] = await h.db.query<{ status: string }>(
      "SELECT status FROM clinic_invitations WHERE invited_phone_e164 = '+12025550177'",
    );
    expect(invite?.status).toBe('REVOKED');

    const detail = data<{ actions: { id: string; actionType: string; status: string }[] }>(
      await ownerApi().get(`/clinic/closure-requests/${id}`),
    );
    expect(detail.actions.map((a) => a.actionType)).toEqual([
      'ACTIVE_BOOKINGS',
      'OPEN_QUEUE_AND_CASES',
      'PATIENT_NOTIFICATION',
      'MEDICAL_RECORDS_RETENTION',
      'FINANCIAL_RECORDS',
      'MEMBERSHIPS_AND_ADMIN_TASKS',
    ]);
    expect(
      code(await as(h, admin).post(`/admin/closure-requests/${id}/complete`, { reason: 'Done' })),
    ).toBe('CLOSURE_BLOCKED');

    const [first, ...rest] = detail.actions;
    expect(
      (
        await as(h, admin).post(`/admin/closure-requests/${id}/actions/${first!.id}/waive`, {
          note: 'No bookings module yet',
        })
      ).status,
    ).toBe(204);
    for (const a of rest)
      expect(
        (
          await ownerApi().post(`/clinic/closure-requests/${id}/actions/${a.id}/resolve`, {
            note: 'Handled and confirmed',
          })
        ).status,
      ).toBe(204);
    expect(
      (
        await as(h, admin).post(`/admin/closure-requests/${id}/complete`, {
          reason: 'All actions handled',
        })
      ).status,
    ).toBe(204);

    const profile = data<{
      clinic: { operationalStatus: string };
      operatingState: { subscriptionStatus: string };
    }>(await ownerApi().get('/clinic'));
    expect(profile.clinic.operationalStatus).toBe('CLOSED');
    expect(profile.operatingState.subscriptionStatus).toBe('EXPIRED');
    expect((await probe(doctor.session, PROBE.READ)).status).toBe(200);
    expect(code(await probe(doctor.session, PROBE.CONTINUITY_OF_CARE))).toBe('CLINIC_CLOSED');
    expect(
      code(
        await ownerApi().post('/clinic/closure-requests', {
          reason: 'Closing a closed clinic again',
        }),
      ),
    ).toBe('CLINIC_CLOSED');
    expect(code(await ownerApi().patch('/clinic', { description: 'changed' }))).toBe(
      'CLINIC_CLOSED',
    );
    expect(await h.db.query('SELECT id FROM clinics WHERE id = ?', [clinic.clinicId])).toHaveLength(
      1,
    );
    expect(
      await h.db.query(`SELECT id FROM clinic_memberships WHERE clinic_id = ?`, [clinic.clinicId]),
    ).toHaveLength(2);
    const events = await h.db.query<{ event_type: string }>(
      'SELECT event_type FROM domain_events WHERE clinic_id = ?',
      [clinic.clinicId],
    );
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['clinic.closing', 'clinic.closed']),
    );
  });

  it('only one open request; owner can cancel before review; other roles cannot request', async () => {
    const first = await ownerApi().post('/clinic/closure-requests', {
      reason: 'Moving to another city',
    });
    expect(
      (await ownerApi().post('/clinic/closure-requests', { reason: 'Second request for closure' }))
        .status,
    ).toBe(409);
    expect(
      (
        await as(h, doctor.session, { clinicId: clinic.clinicId }).post(
          '/clinic/closure-requests',
          { reason: 'Doctor wants closure' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await ownerApi().post(`/clinic/closure-requests/${data<{ id: string }>(first).id}/cancel`))
        .status,
    ).toBe(204);
    expect(
      (await ownerApi().post('/clinic/closure-requests', { reason: 'Changed my mind again' }))
        .status,
    ).toBe(201);
  });

  it('rejection keeps the clinic ACTIVE', async () => {
    const id = data<{ id: string }>(
      await ownerApi().post('/clinic/closure-requests', { reason: 'Temporary financial problems' }),
    ).id;
    expect(
      (
        await as(h, admin).post(`/admin/closure-requests/${id}/reject`, {
          reason: 'Use a suspension instead',
        })
      ).status,
    ).toBe(204);
    expect(
      data<{ clinic: { operationalStatus: string } }>(await ownerApi().get('/clinic')).clinic
        .operationalStatus,
    ).toBe('ACTIVE');
  });
});
