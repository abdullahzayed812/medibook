import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/modules/clinic-setup/time-zone.js';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import {
  adminSession,
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
  nextTransitionDate,
  setBranchTimeZone,
  today,
  verifiedDoctor,
  type Doctor,
} from '../support/setup.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let c: OnboardedClinic;
let doctor: Doctor;
let assignment: string;
let t0: string; // branch-local today (Africa/Cairo)
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  c = await onboardClinic(h, admin, { paid: true });
  await setBranchTimeZone(h, c, c.branchId, 'Africa/Cairo');
  doctor = await verifiedDoctor(h, c);
  assignment = await assign(h, c, c.branchId, doctor.membershipId);
  t0 = today(h);
});

interface Day {
  date: string;
  local: { start: string; end: string }[];
  utc: { startsAt: string; endsAt: string }[];
}
const owner = () => api(h, c.owner, c);
const opening = async (branchId: string, from: string, to = from) =>
  data<{ days: Day[] }>(
    await owner().get(`/clinic/branches/${branchId}/opening-time?from=${from}&to=${to}`),
  ).days;
const working = async (a: string, from: string, to = from) =>
  data<{ days: Day[]; effective: boolean; blockers: string[] }>(
    await owner().get(`/clinic/doctor-assignments/${a}/working-time?from=${from}&to=${to}`),
  );
const ranges = (d: Day | undefined) => (d?.local ?? []).map((x) => `${x.start}-${x.end}`);
const exception = (path: string, body: object) => owner().post(path, body);

describe('branch operating hours', () => {
  it('supports several periods per day, breaks and effective dates', async () => {
    const res = await branchHours(h, c, c.branchId, {
      effectiveFrom: t0,
      effectiveUntil: addDays(t0, 30),
      periods: [
        ...every('09:00', '13:00', { breaks: [['11:00', '11:15']] }),
        ...every('16:00', '21:00', { days: ['MON', 'TUE', 'WED', 'THU', 'SUN'] }),
      ],
    });
    expect(res.status).toBe(201);
    const days = await opening(c.branchId, t0, addDays(t0, 6));
    expect(days.some((d) => ranges(d).join(',') === '09:00-11:00,11:15-13:00,16:00-21:00')).toBe(
      true,
    );
    expect(days.some((d) => ranges(d).join(',') === '09:00-11:00,11:15-13:00')).toBe(true); // FRI/SAT
    // Effective end: nothing after effectiveUntil.
    expect(ranges((await opening(c.branchId, addDays(t0, 31)))[0])).toEqual([]);
  });

  it('rejects invalid and overlapping periods, past starts and overlapping versions; boundaries are inclusive', async () => {
    const bad = async (periods: object[], extra: object = {}) =>
      code(await branchHours(h, c, c.branchId, { effectiveFrom: t0, periods, ...extra }));
    expect(await bad([{ day: 'MON', start: '13:00', end: '09:00' }])).toBe('VALIDATION_ERROR');
    expect(await bad([{ day: 'MON', start: '22:00', end: '02:00' }])).toBe('VALIDATION_ERROR'); // no single overnight period
    expect(
      await bad([
        { day: 'MON', start: '09:00', end: '13:00' },
        { day: 'MON', start: '12:00', end: '15:00' },
      ]),
    ).toBe('VALIDATION_ERROR');
    expect(
      await bad([
        { day: 'MON', start: '09:00', end: '13:00' },
        { day: 'MON', kind: 'BREAK', start: '14:00', end: '15:00' },
      ]),
    ).toBe('VALIDATION_ERROR');
    expect(await bad([{ day: 'MON', start: '9:00', end: '13:00' }])).toBe('VALIDATION_ERROR');
    expect(await bad(every('09:00', '13:00'), { effectiveFrom: addDays(t0, -1) })).toBe(
      'VALIDATION_ERROR',
    );

    // Overnight = two periods across midnight.
    const until = addDays(t0, 9);
    expect(
      (
        await branchHours(h, c, c.branchId, {
          effectiveFrom: t0,
          effectiveUntil: until,
          periods: [...every('18:00', '24:00'), ...every('00:00', '02:00')],
        })
      ).status,
    ).toBe(201);
    expect(
      code(
        await branchHours(h, c, c.branchId, {
          effectiveFrom: until,
          periods: every('09:00', '17:00'),
        }),
      ),
    ).toBe('SCHEDULE_OVERLAP');
    expect(
      (
        await branchHours(h, c, c.branchId, {
          effectiveFrom: addDays(until, 1),
          periods: every('09:00', '17:00'),
        })
      ).status,
    ).toBe(201);
    expect(ranges((await opening(c.branchId, until))[0])).toEqual(['00:00-02:00', '18:00-24:00']);
    expect(ranges((await opening(c.branchId, addDays(until, 1)))[0])).toEqual(['09:00-17:00']);
  });

  it('holidays, temporary closures and exceptional hours; overlapping exceptions rejected', async () => {
    await branchHours(h, c, c.branchId, { effectiveFrom: t0, periods: every('09:00', '17:00') });
    const path = `/clinic/branches/${c.branchId}/exceptions`;
    const d1 = addDays(t0, 1);
    expect(
      (await exception(path, { kind: 'CLOSED', startDate: d1, reason: 'National holiday' })).status,
    ).toBe(201);
    expect(
      code(await exception(path, { kind: 'CLOSED', startDate: d1, reason: 'Duplicate' })),
    ).toBe('EXCEPTION_OVERLAP');
    const d3 = addDays(t0, 3);
    await exception(path, {
      kind: 'CLOSED',
      startDate: d3,
      endDate: addDays(d3, 2),
      reason: 'Renovation',
    });
    const d7 = addDays(t0, 7);
    await exception(path, {
      kind: 'UNAVAILABLE',
      startDate: d7,
      start: '00:00',
      end: '24:00',
      reason: 'Ramadan hours',
    });
    await exception(path, {
      kind: 'EXTRA',
      startDate: d7,
      start: '20:00',
      end: '23:00',
      reason: 'Ramadan hours',
    });
    const d8 = addDays(t0, 8);
    await exception(path, {
      kind: 'UNAVAILABLE',
      startDate: d8,
      start: '12:00',
      end: '14:00',
      reason: 'Staff meeting',
    });
    const days = await opening(c.branchId, t0, d8);
    const byDate = new Map(days.map((d) => [d.date, ranges(d)]));
    expect(byDate.get(d1)).toEqual([]);
    expect([3, 4, 5].map((n) => byDate.get(addDays(t0, n)))).toEqual([[], [], []]);
    expect(byDate.get(d7)).toEqual(['20:00-23:00']);
    expect(byDate.get(d8)).toEqual(['09:00-12:00', '14:00-17:00']);
    expect(byDate.get(addDays(t0, 2))).toEqual(['09:00-17:00']);
    // Cancel restores; long closures and past dates are rejected.
    const holiday = data<{ id: string }[]>(
      await owner().get(`${path}?status=ACTIVE&from=${d1}&to=${d1}`),
    )[0];
    expect(
      (await owner().post(`/clinic/schedule-exceptions/${holiday?.id}/cancel`, {})).status,
    ).toBe(200);
    expect(ranges((await opening(c.branchId, d1))[0])).toEqual(['09:00-17:00']);
    expect(
      code(
        await exception(path, {
          kind: 'CLOSED',
          startDate: t0,
          endDate: addDays(t0, 400),
          reason: 'Too long',
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      code(await exception(path, { kind: 'CLOSED', startDate: addDays(t0, -2), reason: 'Past' })),
    ).toBe('VALIDATION_ERROR');
  });

  it('time zone: validated, and locked while schedules exist', async () => {
    expect(
      code(await owner().post('/clinic/branches', { name: 'Bad TZ', timeZone: 'Mars/Olympus' })),
    ).toBe('VALIDATION_ERROR');
    await branchHours(h, c, c.branchId, { effectiveFrom: t0, periods: every('09:00', '17:00') });
    expect(
      code(await owner().patch(`/clinic/branches/${c.branchId}`, { timeZone: 'Europe/London' })),
    ).toBe('BRANCH_TIME_ZONE_LOCKED');
    expect(
      (await owner().patch(`/clinic/branches/${c.branchId}`, { name: 'Renamed' })).status,
    ).toBe(200);
  });
});

describe('doctor schedules', () => {
  const hours = () =>
    branchHours(h, c, c.branchId, {
      effectiveFrom: t0,
      periods: every('08:00', '22:00', { breaks: [['14:00', '15:00']] }),
    });

  it('multiple periods and breaks within branch hours; working time intersects branch closures', async () => {
    await hours();
    const res = await doctorSchedule(h, c, assignment, {
      effectiveFrom: t0,
      periods: [
        ...every('09:00', '13:00', { breaks: [['11:00', '11:30']] }),
        ...every('16:00', '20:00', { days: ['SUN', 'TUE'] }),
      ],
    });
    expect(res.status).toBe(201);
    const wt = await working(assignment, t0, addDays(t0, 6));
    expect(wt.effective).toBe(true);
    expect(wt.days.some((d) => ranges(d).join(',') === '09:00-11:00,11:30-13:00,16:00-20:00')).toBe(
      true,
    );
    // UTC instants use the branch zone (Cairo is UTC+2 in winter, +3 in summer).
    const first = wt.days[0]?.utc[0];
    expect(first?.startsAt.slice(0, 10)).toBe(t0);
    // Branch holiday removes the doctor's time that day.
    await exception(`/clinic/branches/${c.branchId}/exceptions`, {
      kind: 'CLOSED',
      startDate: addDays(t0, 1),
      reason: 'Holiday',
    });
    expect(ranges((await working(assignment, addDays(t0, 1))).days[0])).toEqual([]);
  });

  it('rejects schedules outside branch hours, during branch breaks, without branch hours, or overlapping', async () => {
    expect(
      code(
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: t0,
          periods: every('09:00', '12:00'),
        }),
      ),
    ).toBe('BRANCH_HOURS_NOT_COVERED');
    await branchHours(h, c, c.branchId, {
      effectiveFrom: t0,
      effectiveUntil: addDays(t0, 60),
      periods: every('08:00', '22:00', { breaks: [['14:00', '15:00']] }),
    });
    const within = { effectiveFrom: t0, effectiveUntil: addDays(t0, 30) };
    const outside = await doctorSchedule(h, c, assignment, {
      ...within,
      periods: every('07:00', '10:00'),
    });
    expect(code(outside)).toBe('OUTSIDE_BRANCH_HOURS');
    expect(JSON.stringify(outside.body)).toMatch(/"start":"07:00","end":"08:00"/);
    expect(
      code(await doctorSchedule(h, c, assignment, { ...within, periods: every('13:00', '16:00') })),
    ).toBe('OUTSIDE_BRANCH_HOURS');
    // Open-ended doctor schedule beyond the branch version's end → gap.
    expect(
      code(
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: t0,
          periods: every('09:00', '12:00'),
        }),
      ),
    ).toBe('BRANCH_HOURS_NOT_COVERED');
    const until = addDays(t0, 20);
    expect(
      (
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: t0,
          effectiveUntil: until,
          periods: every('09:00', '12:00'),
        })
      ).status,
    ).toBe(201);
    expect(
      code(
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: until,
          effectiveUntil: addDays(t0, 30),
          periods: every('16:00', '18:00'),
        }),
      ),
    ).toBe('SCHEDULE_OVERLAP');
    expect(
      (
        await doctorSchedule(h, c, assignment, {
          effectiveFrom: addDays(until, 1),
          effectiveUntil: addDays(t0, 30),
          periods: every('16:00', '18:00'),
        })
      ).status,
    ).toBe(201);
    expect(ranges((await working(assignment, until)).days[0])).toEqual(['09:00-12:00']);
    expect(ranges((await working(assignment, addDays(until, 1))).days[0])).toEqual(['16:00-18:00']);
  });

  it('revisions keep history; branch-hour changes cannot strand doctor schedules', async () => {
    const branch = data<{ id: string }>(await hours());
    const v1 = data<{ id: string }>(
      await doctorSchedule(h, c, assignment, {
        effectiveFrom: t0,
        periods: every('09:00', '12:00'),
      }),
    );
    const from = addDays(t0, 7);
    const v2 = await owner().post(`/clinic/schedules/${v1.id}/revisions`, {
      effectiveFrom: from,
      periods: every('10:00', '13:00'),
    });
    expect(v2.status).toBe(201);
    expect(data(v2)).toMatchObject({
      revision: 2,
      supersedesScheduleId: v1.id,
      effectiveFrom: from,
    });
    expect(data(await owner().get(`/clinic/schedules/${v1.id}`))).toMatchObject({
      status: 'ACTIVE',
      effectiveUntil: addDays(from, -1),
    });
    expect(
      data<{ periods: unknown[] }>(await owner().get(`/clinic/schedules/${v1.id}`)).periods,
    ).toContainEqual({
      day: 'MON',
      kind: 'WORK',
      start: '09:00',
      end: '12:00',
    });
    expect(ranges((await working(assignment, from)).days[0])).toEqual(['10:00-13:00']);

    // Shrinking branch hours below the doctor's time, or removing them, is refused.
    expect(
      code(
        await owner().post(`/clinic/schedules/${branch.id}/revisions`, {
          effectiveFrom: from,
          periods: every('12:00', '20:00'),
        }),
      ),
    ).toBe('BRANCH_HOURS_IN_USE');
    expect(
      code(
        await owner().post(`/clinic/schedules/${branch.id}/deactivate`, {
          reason: 'closing branch',
        }),
      ),
    ).toBe('BRANCH_HOURS_IN_USE');
    // Deactivate the doctor schedule: history kept, working time empty; activate re-validates.
    const v2id = data<{ id: string }>(v2).id;
    expect(
      (await owner().post(`/clinic/schedules/${v2id}/deactivate`, { reason: 'Leaving' })).status,
    ).toBe(200);
    expect(ranges((await working(assignment, from)).days[0])).toEqual([]);
    expect(
      await h.db.query('SELECT id FROM schedule_periods WHERE schedule_id = ?', [v2id]),
    ).not.toHaveLength(0);
    expect(data(await owner().post(`/clinic/schedules/${v2id}/activate`, {}))).toMatchObject({
      status: 'ACTIVE',
    });
    expect(
      await h.db.query(
        `SELECT action FROM audit_events WHERE action IN ('SCHEDULE_CREATED', 'SCHEDULE_CHANGED')`,
      ),
    ).toHaveLength(5);
  });

  it('leave, partial unavailability and additional periods (inside branch hours only)', async () => {
    await hours();
    await doctorSchedule(h, c, assignment, { effectiveFrom: t0, periods: every('09:00', '13:00') });
    const path = `/clinic/doctor-assignments/${assignment}/exceptions`;
    const d1 = addDays(t0, 1);
    const d2 = addDays(t0, 2);
    const d3 = addDays(t0, 3);
    const d4 = addDays(t0, 4);
    expect(
      (
        await exception(path, {
          kind: 'CLOSED',
          startDate: d1,
          endDate: d2,
          reason: 'Annual leave',
        })
      ).status,
    ).toBe(201);
    await exception(path, {
      kind: 'UNAVAILABLE',
      startDate: d3,
      start: '10:00',
      end: '11:00',
      reason: 'Conference call',
    });
    expect(
      (
        await exception(path, {
          kind: 'EXTRA',
          startDate: d4,
          start: '17:00',
          end: '19:00',
          reason: 'Extra clinic',
        })
      ).status,
    ).toBe(201);
    expect(
      code(
        await exception(path, {
          kind: 'EXTRA',
          startDate: d4,
          start: '21:00',
          end: '23:00',
          reason: 'Too late',
        }),
      ),
    ).toBe('OUTSIDE_BRANCH_HOURS');
    expect(
      code(
        await exception(path, {
          kind: 'EXTRA',
          startDate: d4,
          start: '14:00',
          end: '15:00',
          reason: 'Branch break',
        }),
      ),
    ).toBe('OUTSIDE_BRANCH_HOURS');
    const wt = new Map((await working(assignment, d1, d4)).days.map((d) => [d.date, ranges(d)]));
    expect(wt.get(d1)).toEqual([]);
    expect(wt.get(d2)).toEqual([]);
    expect(wt.get(d3)).toEqual(['09:00-10:00', '11:00-13:00']);
    expect(wt.get(d4)).toEqual(['09:00-13:00', '17:00-19:00']);
  });

  it('same doctor at two branches: allowed when apart, refused when real times overlap (same zone)', async () => {
    await hours();
    const second = await addBranch(h, c, 'Second', 'Africa/Cairo');
    await branchHours(h, c, second, { effectiveFrom: t0, periods: every('08:00', '22:00') });
    const a2 = await assign(h, c, second, doctor.membershipId);
    await doctorSchedule(h, c, assignment, { effectiveFrom: t0, periods: every('09:00', '13:00') });
    expect(
      (await doctorSchedule(h, c, a2, { effectiveFrom: t0, periods: every('15:00', '20:00') }))
        .status,
    ).toBe(201);
    const extra = await exception(`/clinic/doctor-assignments/${a2}/exceptions`, {
      kind: 'EXTRA',
      startDate: addDays(t0, 2),
      start: '12:00',
      end: '13:30',
      reason: 'Covering',
    });
    expect(code(extra)).toBe('DOCTOR_SCHEDULE_CONFLICT');
    // Another clinic's schedules never block this one (and are invisible to it).
    const c2 = await onboardClinic(h, admin, { paid: true });
    await setBranchTimeZone(h, c2, c2.branchId, 'Africa/Cairo');
    const d2 = await verifiedDoctor(h, c2, { member: doctor });
    const a3 = data<{ id: string }>(
      await api(h, c2.owner, c2).post(`/clinic/branches/${c2.branchId}/doctors`, {
        membershipId: d2.membershipId,
      }),
    ).id;
    await api(h, c2.owner, c2).post(`/clinic/branches/${c2.branchId}/hours`, {
      effectiveFrom: t0,
      periods: every('08:00', '22:00'),
    });
    expect(
      (
        await api(h, c2.owner, c2).post(`/clinic/doctor-assignments/${a3}/schedules`, {
          effectiveFrom: t0,
          periods: every('09:00', '13:00'),
        })
      ).status,
    ).toBe(201);
  });

  it('cross-branch conflicts use each branch time zone, including DST seasons', async () => {
    // Cairo (EET/EEST) and London (GMT/BST) change clocks on different dates. 10:00–12:00 Cairo
    // and 10:00–11:00 London overlap only while London is on BST and Cairo is not yet on EEST
    // (late March → late April): 08:00–10:00Z vs 09:00–10:00Z. In winter and summer they do not.
    await branchHours(h, c, c.branchId, { effectiveFrom: t0, periods: every('08:00', '20:00') });
    const london = await addBranch(h, c, 'London', 'Europe/London');
    const tl = today(h, 'Europe/London');
    await branchHours(h, c, london, { effectiveFrom: tl, periods: every('08:00', '20:00') });
    const aLondon = await assign(h, c, london, doctor.membershipId);
    await doctorSchedule(h, c, assignment, {
      effectiveFrom: t0,
      periods: every('10:00', '12:00', { days: ['MON'] }),
    });
    // 11:00–12:00 London never meets 10:00–12:00 Cairo (11–12Z/10–11Z vs 08–10Z/07–09Z).
    expect(
      (
        await doctorSchedule(h, c, aLondon, {
          effectiveFrom: tl,
          effectiveUntil: addDays(tl, 13),
          periods: every('11:00', '12:00', { days: ['MON'] }),
        })
      ).status,
    ).toBe(201);
    const seasonal = await doctorSchedule(h, c, aLondon, {
      effectiveFrom: addDays(tl, 14),
      periods: every('10:00', '11:00', { days: ['MON'] }),
    });
    expect(code(seasonal)).toBe('DOCTOR_SCHEDULE_CONFLICT');
    const at = (seasonal.body as { error: { details: { startsAt: string } } }).error.details
      .startsAt;
    expect(at.slice(5, 7)).toMatch(/0[34]/); // March or April
  });

  it('DST: nonexistent and repeated local times follow the documented rule', async () => {
    const ny = await addBranch(h, c, 'New York', 'America/New_York');
    const tn = today(h, 'America/New_York');
    await branchHours(h, c, ny, { effectiveFrom: tn, periods: every('00:00', '24:00') });
    const a = await assign(h, c, ny, doctor.membershipId);
    const spring = nextTransitionDate('America/New_York', tn, 'forward');
    const fall = nextTransitionDate('America/New_York', addDays(tn, 1), 'back');
    expect(
      (
        await doctorSchedule(h, c, a, {
          effectiveFrom: tn,
          periods: [{ day: 'SUN', start: '01:00', end: '04:00' }],
        })
      ).status,
    ).toBe(201);
    const hoursOf = (d: Day | undefined) =>
      (d?.utc ?? []).reduce((sum, x) => sum + (Date.parse(x.endsAt) - Date.parse(x.startsAt)), 0) /
      3_600_000;
    // Spring forward: 02:00–02:59 do not exist → 01:00–04:00 is 2 real hours, never shifted.
    const sp = (await working(a, spring)).days[0];
    expect(ranges(sp)).toEqual(['01:00-04:00']);
    expect(hoursOf(sp)).toBe(2);
    expect(sp?.utc[0]?.startsAt).toBe(`${spring}T06:00:00.000Z`); // 01:00 EST
    // Fall back: 01:00 happens twice → from its first occurrence to 04:00 EST = 4 real hours.
    const fb = (await working(a, fall)).days[0];
    expect(hoursOf(fb)).toBe(4);
    expect(fb?.utc[0]?.startsAt).toBe(`${fall}T05:00:00.000Z`); // first 01:00 (EDT)
  });

  it('concurrent conflicting schedule writes: exactly one commits', async () => {
    await hours();
    const second = await addBranch(h, c, 'Second', 'Africa/Cairo');
    await branchHours(h, c, second, { effectiveFrom: t0, periods: every('08:00', '22:00') });
    const a2 = await assign(h, c, second, doctor.membershipId);
    const body = { effectiveFrom: t0, periods: every('09:00', '12:00') };
    const same = await Promise.all([1, 2, 3].map(() => doctorSchedule(h, c, assignment, body)));
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
    expect(same.filter((r) => code(r) === 'SCHEDULE_OVERLAP')).toHaveLength(2);
    // Cross-branch race: the doctor cannot end up at both branches at once.
    const body2 = { effectiveFrom: t0, periods: every('15:00', '18:00') };
    const third = await addBranch(h, c, 'Third', 'Africa/Cairo');
    await branchHours(h, c, third, { effectiveFrom: t0, periods: every('08:00', '22:00') });
    const a3 = await assign(h, c, third, doctor.membershipId);
    const cross = await Promise.all([
      doctorSchedule(h, c, a2, body2),
      doctorSchedule(h, c, a3, body2),
    ]);
    expect(cross.map((r) => r.status).sort()).toEqual([201, 409]);
    const active = await h.db.query(
      `SELECT id FROM schedules WHERE owner_type = 'DOCTOR' AND status = 'ACTIVE'`,
    );
    expect(active).toHaveLength(2);
  });

  it('doctors view their own schedules and working time but cannot change them', async () => {
    await hours();
    await doctorSchedule(h, c, assignment, { effectiveFrom: t0, periods: every('09:00', '12:00') });
    const d = api(h, doctor.session, c);
    expect((await d.get(`/clinic/doctor-assignments/${assignment}/schedules`)).status).toBe(200);
    expect(
      (await d.get(`/clinic/doctor-assignments/${assignment}/working-time?from=${t0}&to=${t0}`))
        .status,
    ).toBe(200);
    expect(
      code(
        await d.post(`/clinic/doctor-assignments/${assignment}/schedules`, {
          effectiveFrom: addDays(t0, 100),
          periods: every('09:00', '10:00'),
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await d.post(`/clinic/doctor-assignments/${assignment}/exceptions`, {
          kind: 'CLOSED',
          startDate: t0,
          reason: 'Self leave',
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await d.get(
          `/clinic/doctor-assignments/${assignment}/working-time?from=${t0}&to=${addDays(t0, 90)}`,
        ),
      ),
    ).toBe('VALIDATION_ERROR');
  });
});
