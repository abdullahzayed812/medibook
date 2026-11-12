import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { addBranch, api, assign, every, today, verifiedDoctor } from '../support/setup.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let c: OnboardedClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  c = await onboardClinic(h, admin, { paid: true });
});

interface AssignmentView {
  id: string;
  status: string;
  effective: boolean;
  blockers: string[];
  branch: { id: string };
  membershipId: string;
}
const owner = () => api(h, c.owner, c);
const post = (branchId: string, membershipId: string) =>
  owner().post(`/clinic/branches/${branchId}/doctors`, { membershipId });

describe('doctor branch assignments', () => {
  it('assigns an eligible doctor to several branches; lists by branch, by doctor and for the doctor', async () => {
    const second = await addBranch(h, c, 'Second Branch');
    const doctor = await verifiedDoctor(h, c);
    const res = await post(c.branchId, doctor.membershipId);
    expect(res.status).toBe(201);
    expect(data<AssignmentView>(res)).toMatchObject({
      status: 'ACTIVE',
      effective: true,
      blockers: [],
      membershipId: doctor.membershipId,
    });
    expect((await post(second, doctor.membershipId)).status).toBe(201);

    const byBranch = data<AssignmentView[]>(
      await owner().get(`/clinic/branches/${c.branchId}/doctors`),
    );
    expect(byBranch.map((a) => a.membershipId)).toEqual([doctor.membershipId]);
    const byDoctor = data<AssignmentView[]>(
      await owner().get(`/clinic/doctors/${doctor.membershipId}/branches`),
    );
    expect(byDoctor.map((a) => a.branch.id).sort()).toEqual([c.branchId, second].sort());
    const mine = data<AssignmentView[]>(
      await api(h, doctor.session, c).get('/clinic/me/doctor-assignments'),
    );
    expect(mine).toHaveLength(2);
    expect(
      await h.db.query(`SELECT id FROM audit_events WHERE action = 'DOCTOR_ASSIGNMENT_CREATED'`),
    ).toHaveLength(2);
  });

  it('rejects ineligible memberships with explicit reasons', async () => {
    const receptionist = await addStaff(h, c.owner, c.clinicId, 'RECEPTIONIST');
    expect(data<unknown>(await post(c.branchId, receptionist.membershipId))).toBeUndefined();
    const notDoctor = await post(c.branchId, receptionist.membershipId);
    expect(code(notDoctor)).toBe('DOCTOR_NOT_ELIGIBLE');
    expect(JSON.stringify(notDoctor.body)).toMatch(/NOT_A_DOCTOR_MEMBERSHIP/);

    const unverified = await verifiedDoctor(h, c, { verification: 'PENDING_REVIEW' });
    expect(JSON.stringify((await post(c.branchId, unverified.membershipId)).body)).toMatch(
      /DOCTOR_NOT_VERIFIED/,
    );

    const inactive = await verifiedDoctor(h, c);
    await owner().patch(`/clinic/members/${inactive.membershipId}/status`, {
      status: 'INACTIVE',
      reason: 'On sabbatical',
    });
    expect(JSON.stringify((await post(c.branchId, inactive.membershipId)).body)).toMatch(
      /MEMBERSHIP_INACTIVE/,
    );

    // Branch-assigned DOCTOR membership: only its own branches.
    const other = await addBranch(h, c, 'Other');
    const scoped = await verifiedDoctor(h, c, { branchScope: 'ASSIGNED', branchIds: [c.branchId] });
    expect((await post(c.branchId, scoped.membershipId)).status).toBe(201);
    expect(JSON.stringify((await post(other, scoped.membershipId)).body)).toMatch(
      /BRANCH_NOT_COVERED/,
    );
  });

  it('rejects branches and memberships of another clinic as not found', async () => {
    const c2 = await onboardClinic(h, admin, { paid: true });
    const foreignDoctor = await verifiedDoctor(h, c2);
    const doctor = await verifiedDoctor(h, c);
    expect((await post(c2.branchId, doctor.membershipId)).status).toBe(404);
    expect((await post(c.branchId, foreignDoctor.membershipId)).status).toBe(404);
    expect(await h.db.query('SELECT id FROM doctor_branch_assignments')).toEqual([]);
  });

  it('prevents duplicate active assignments; deactivation keeps history and allows a new assignment', async () => {
    const doctor = await verifiedDoctor(h, c);
    const first = await assign(h, c, c.branchId, doctor.membershipId);
    expect(code(await post(c.branchId, doctor.membershipId))).toBe('ASSIGNMENT_EXISTS');
    // Concurrent duplicates: exactly one succeeds (clinic lock + active_key unique).
    const other = await verifiedDoctor(h, c);
    const race = await Promise.all([1, 2, 3].map(() => post(c.branchId, other.membershipId)));
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);

    // Configure, then deactivate: schedule and services are ended, nothing is deleted.
    await owner().post(`/clinic/branches/${c.branchId}/hours`, {
      effectiveFrom: today(h),
      periods: every('08:00', '20:00'),
    });
    expect(
      (
        await owner().post(`/clinic/doctor-assignments/${first}/schedules`, {
          effectiveFrom: today(h),
          periods: every('09:00', '12:00'),
        })
      ).status,
    ).toBe(201);
    const deactivated = await owner().post(`/clinic/doctor-assignments/${first}/deactivate`, {
      reason: 'Moved to another branch',
    });
    expect(data<AssignmentView>(deactivated)).toMatchObject({
      status: 'INACTIVE',
      effective: false,
      blockers: ['ASSIGNMENT_INACTIVE'],
    });
    expect(
      await h.db.query(
        `SELECT status, deactivation_reason FROM schedules WHERE assignment_id = ?`,
        [first],
      ),
    ).toEqual([{ status: 'INACTIVE', deactivation_reason: 'ASSIGNMENT_DEACTIVATED' }]);
    expect(
      code(
        await owner().post(`/clinic/doctor-assignments/${first}/deactivate`, { reason: 'again' }),
      ),
    ).toBe('CONFLICT');

    const again = await post(c.branchId, doctor.membershipId);
    expect(again.status).toBe(201);
    const rows = await h.db.query<{ status: string }>(
      'SELECT status FROM doctor_branch_assignments WHERE membership_id = ? ORDER BY id',
      [doctor.membershipId],
    );
    expect(rows.map((r) => r.status)).toEqual(['INACTIVE', 'ACTIVE']);
  });

  it('only clinic-wide doctor managers can assign; staff can read their branches only', async () => {
    const doctor = await verifiedDoctor(h, c);
    const receptionist = await addStaff(h, c.owner, c.clinicId, 'RECEPTIONIST');
    expect(
      code(
        await api(h, receptionist.session, c).post(`/clinic/branches/${c.branchId}/doctors`, {
          membershipId: doctor.membershipId,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await api(h, doctor.session, c).post(`/clinic/branches/${c.branchId}/doctors`, {
          membershipId: doctor.membershipId,
        }),
      ),
    ).toBe('FORBIDDEN');
    const id = await assign(h, c, c.branchId, doctor.membershipId);
    expect(
      (await api(h, receptionist.session, c).get(`/clinic/doctor-assignments/${id}`)).status,
    ).toBe(200);

    // A branch-assigned manager neither sees nor manages other branches' assignments.
    const other = await addBranch(h, c, 'Other');
    const scopedManager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER', {
      branchScope: 'ASSIGNED',
      branchIds: [other],
    });
    expect(
      (await api(h, scopedManager.session, c).get(`/clinic/doctor-assignments/${id}`)).status,
    ).toBe(404);
    expect(
      (await api(h, scopedManager.session, c).get(`/clinic/branches/${c.branchId}/doctors`)).status,
    ).toBe(404);
    expect(
      code(
        await api(h, scopedManager.session, c).post(`/clinic/branches/${other}/doctors`, {
          membershipId: doctor.membershipId,
        }),
      ),
    ).toBe('FORBIDDEN');
    // Unauthenticated
    expect((await h.http().get(`/api/v1/clinic/doctor-assignments/${id}`)).status).toBe(401);
    expect(
      (await as(h, admin, { clinicId: c.clinicId }).get(`/clinic/doctor-assignments/${id}`)).status,
    ).toBe(403); // a Super Admin has no implicit clinic access
  });
});
