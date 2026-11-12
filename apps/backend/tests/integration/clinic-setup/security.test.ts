import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/modules/clinic-setup/time-zone.js';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import {
  addStaff,
  adminSession,
  as,
  code,
  data,
  onboardClinic,
  type OnboardedClinic,
} from '../support/platform.js';
import {
  addBranch,
  api,
  assign,
  branchHours,
  doctorSchedule,
  every,
  setBranchTimeZone,
  today,
  verifiedDoctor,
  type Doctor,
} from '../support/setup.js';

/** Task 04 security & regression: tenant isolation, branch scope, gate, subscription, revocation. */
const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let c: OnboardedClinic;
let doctor: Doctor;
let assignment: string;
let t0: string;
let ids: { schedule: string; service: string; exception: string };
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  c = await onboardClinic(h, admin, { paid: true });
  await setBranchTimeZone(h, c, c.branchId, 'Africa/Cairo');
  doctor = await verifiedDoctor(h, c);
  assignment = await assign(h, c, c.branchId, doctor.membershipId);
  t0 = today(h);
  const hours = data<{ id: string }>(
    await branchHours(h, c, c.branchId, { effectiveFrom: t0, periods: every('08:00', '20:00') }),
  );
  const service = data<{ id: string }>(
    await owner().post('/clinic/services', { nameEn: 'Consult' }),
  );
  await owner().put(`/clinic/branches/${c.branchId}/services/${service.id}`, {
    priceMinor: 25000,
    durationMinutes: 15,
  });
  const exception = data<{ id: string }>(
    await owner().post(`/clinic/branches/${c.branchId}/exceptions`, {
      kind: 'CLOSED',
      startDate: addDays(t0, 5),
      reason: 'Holiday',
    }),
  );
  ids = { schedule: hours.id, service: service.id, exception: exception.id };
});

const owner = () => api(h, c.owner, c);

describe('clinic setup security', () => {
  it('another clinic cannot read or change any of this clinic’s setup by changing ids', async () => {
    const c2 = await onboardClinic(h, admin, { paid: true });
    const other = api(h, c2.owner, c2);
    const probes: [string, string, object?][] = [
      ['get', `/clinic/branches/${c.branchId}/doctors`],
      ['get', `/clinic/doctor-assignments/${assignment}`],
      ['get', `/clinic/doctors/${doctor.membershipId}/branches`],
      ['get', `/clinic/services/${ids.service}`],
      ['get', `/clinic/branches/${c.branchId}/services`],
      ['get', `/clinic/branches/${c.branchId}/hours`],
      ['get', `/clinic/schedules/${ids.schedule}`],
      ['get', `/clinic/doctor-assignments/${assignment}/working-time?from=${t0}&to=${t0}`],
      ['patch', `/clinic/services/${ids.service}`, { nameEn: 'Hijacked' }],
      [
        'put',
        `/clinic/branches/${c.branchId}/services/${ids.service}`,
        { priceMinor: 1, durationMinutes: 10 },
      ],
      ['post', `/clinic/schedules/${ids.schedule}/deactivate`, { reason: 'Hijack' }],
      ['post', `/clinic/schedule-exceptions/${ids.exception}/cancel`, {}],
      ['post', `/clinic/doctor-assignments/${assignment}/deactivate`, { reason: 'Hijack' }],
      [
        'post',
        `/clinic/doctor-assignments/${assignment}/schedules`,
        { effectiveFrom: t0, periods: every('09:00', '10:00') },
      ],
    ];
    for (const [method, path, payload] of probes) {
      const res =
        method === 'get'
          ? await other.get(path)
          : await (
              other[method as 'post'] as (p: string, b: object) => Promise<{ status: number }>
            )(path, payload ?? {});
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    // Using the victim clinic id as context is refused outright.
    expect(code(await as(h, c2.owner, { clinicId: c.clinicId }).get('/clinic/services'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    // Nothing changed.
    expect(
      data<{ name: { en: string } }>(await owner().get(`/clinic/services/${ids.service}`)).name.en,
    ).toBe('Consult');
    expect(
      data<{ status: string }>(await owner().get(`/clinic/schedules/${ids.schedule}`)).status,
    ).toBe('ACTIVE');
  });

  it('branch-assigned managers manage schedules only at their branches and cannot assign doctors', async () => {
    const other = await addBranch(h, c, 'Other', 'Africa/Cairo');
    const manager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER', {
      branchScope: 'ASSIGNED',
      branchIds: [other],
    });
    const m = api(h, manager.session, c);
    expect(
      (
        await m.post(`/clinic/branches/${other}/hours`, {
          effectiveFrom: t0,
          periods: every('09:00', '17:00'),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await m.post(`/clinic/branches/${c.branchId}/hours`, {
          effectiveFrom: t0,
          periods: every('09:00', '17:00'),
        })
      ).status,
    ).toBe(404);
    expect(
      (await m.post(`/clinic/schedules/${ids.schedule}/deactivate`, { reason: 'Not mine' })).status,
    ).toBe(404);
    expect(
      (
        await m.post(`/clinic/doctor-assignments/${assignment}/schedules`, {
          effectiveFrom: t0,
          periods: every('09:00', '10:00'),
        })
      ).status,
    ).toBe(404);
    const otherDoctor = await verifiedDoctor(h, c);
    expect(
      code(
        await m.post(`/clinic/branches/${other}/doctors`, {
          membershipId: otherDoctor.membershipId,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(code(await m.post('/clinic/services', { nameEn: 'Nope' }))).toBe('FORBIDDEN');
  });

  it('clinic operation gate: FULL suspension blocks setup changes but not reads; NEW_OPERATIONS does not block setup', async () => {
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/suspend`, {
      scope: 'FULL',
      reason: 'Investigation',
    });
    expect(
      code(
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: t0,
          periods: every('09:00', '10:00'),
        }),
      ),
    ).toBe('CLINIC_SUSPENDED');
    expect(code(await owner().post('/clinic/services', { nameEn: 'During suspension' }))).toBe(
      'CLINIC_SUSPENDED',
    );
    expect((await owner().get(`/clinic/branches/${c.branchId}/hours`)).status).toBe(200);
    expect((await owner().get('/clinic/services')).status).toBe(200);
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/reinstate`, { reason: 'Cleared' });
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/suspend`, {
      scope: 'NEW_OPERATIONS',
      reason: 'Fines',
    });
    expect(
      (
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: t0,
          periods: every('09:00', '10:00'),
        })
      ).status,
    ).toBe(201);
  });

  it('a restricted subscription does not block configuration (ADR-026: ADMINISTRATION stays available)', async () => {
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/suspend`, {
      reason: 'Chargeback',
    });
    expect((await owner().post('/clinic/services', { nameEn: 'Still configurable' })).status).toBe(
      201,
    );
    expect(
      (
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: t0,
          periods: every('09:00', '10:00'),
        })
      ).status,
    ).toBe(201);
  });

  it('revoking the doctor membership or verification makes the assignment ineffective; nothing is deleted', async () => {
    await doctorSchedule(h, c, assignment, { effectiveFrom: t0, periods: every('09:00', '12:00') });
    const verificationChange = await h.db.execute(
      `UPDATE doctor_profiles SET verification_status = 'SUSPENDED' WHERE user_id = ?`,
      [doctor.session.userId],
    );
    expect(verificationChange.affectedRows).toBe(1);
    expect(
      data<{ blockers: string[] }>(await owner().get(`/clinic/doctor-assignments/${assignment}`))
        .blockers,
    ).toEqual(['DOCTOR_NOT_VERIFIED']);
    await h.db.execute(
      `UPDATE doctor_profiles SET verification_status = 'VERIFIED' WHERE user_id = ?`,
      [doctor.session.userId],
    );

    expect(
      (
        await owner().patch(`/clinic/members/${doctor.membershipId}/status`, {
          status: 'TERMINATED',
          reason: 'Left the clinic',
        })
      ).status,
    ).toBe(204);
    const view = data<{ status: string; effective: boolean; blockers: string[] }>(
      await owner().get(`/clinic/doctor-assignments/${assignment}`),
    );
    expect(view).toMatchObject({
      status: 'ACTIVE',
      effective: false,
      blockers: ['MEMBERSHIP_INACTIVE'],
    });
    const wt = data<{ effective: boolean; days: { utc: unknown[] }[] }>(
      await owner().get(
        `/clinic/doctor-assignments/${assignment}/working-time?from=${t0}&to=${t0}`,
      ),
    );
    expect(wt.effective).toBe(false);
    expect(wt.days[0]?.utc).toEqual([]);
    expect(
      code(
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: addDays(t0, 200),
          periods: every('09:00', '10:00'),
        }),
      ),
    ).toBe('ASSIGNMENT_NOT_ELIGIBLE');
    expect(code(await api(h, doctor.session, c).get('/clinic/me/doctor-assignments'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect(
      await h.db.query('SELECT id FROM schedules WHERE assignment_id = ?', [assignment]),
    ).toHaveLength(1);
  });

  it('audit events are written for every setup change, without secrets', async () => {
    const actions = (
      await h.db.query<{ action: string }>(
        `SELECT DISTINCT action FROM audit_events WHERE clinic_id = ?`,
        [c.clinicId],
      )
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'DOCTOR_ASSIGNMENT_CREATED',
        'SCHEDULE_CREATED',
        'SERVICE_CREATED',
        'SERVICE_OFFERING_CHANGED',
        'SCHEDULE_EXCEPTION_CHANGED',
      ]),
    );
    const outbox = await h.db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM domain_events WHERE event_type = 'service_offering.changed'`,
    );
    expect(JSON.stringify(outbox)).not.toMatch(/25000/); // prices stay out of the outbox
  });
});
