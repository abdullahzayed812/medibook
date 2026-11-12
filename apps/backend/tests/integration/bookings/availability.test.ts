import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/modules/clinic-setup/time-zone.js';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import { adminSession, as, code, data } from '../support/platform.js';
import {
  availability,
  bookableClinic,
  bookSlot,
  clinic,
  confirm,
  patient,
  slots,
  startsOf,
  type BookableClinic,
} from '../support/bookings.js';
import {
  assign,
  doctorSchedule,
  every,
  nextTransitionDate,
  verifiedDoctor,
} from '../support/setup.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let b: BookableClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  b = await bookableClinic(h, admin);
});

const ALL = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];

describe('availability', () => {
  it('normal working day: slots of the service duration inside working time, safe payload', async () => {
    const res = await slots(h, b);
    expect(res.available).toBe(true);
    expect(res.slots.map((s) => s.local.start)).toEqual(ALL);
    expect(res.slots[0]).toMatchObject({
      assignmentId: b.assignmentId,
      doctor: { displayName: 'Dr. Synthetic Example' },
      durationMinutes: 30,
      price: { amountMinor: 20000, currency: 'EGP' },
    });
    // Cairo is UTC+2 in winter / +3 in summer: UTC differs from local by the real offset.
    const s0 = res.slots[0];
    expect(new Date(s0?.startsAt ?? '').getTime()).toBeLessThan(Date.parse(`${b.day}T09:00:00Z`));
    // Only what a patient needs: no booking ids, persons, profiles or internal statuses.
    expect(JSON.stringify(res)).not.toMatch(/personId|patientProfile|bookingId|membership/);
  });

  it('multiple periods and breaks, holidays, leave and extra periods, effective date boundaries', async () => {
    const o = clinic(h, b);
    const sched = data<{ id: string }[]>(
      await o.get(`/clinic/doctor-assignments/${b.assignmentId}/schedules`),
    )[0];
    await o.post(`/clinic/schedules/${sched?.id}/revisions`, {
      effectiveFrom: addDays(b.day, 1),
      periods: [
        ...every('09:00', '13:00', { breaks: [['10:00', '11:00']] }),
        ...every('16:00', '17:00'),
      ],
    });
    expect(await startsOf(h, b)).toEqual(ALL); // boundary: old version still applies on b.day
    expect(await startsOf(h, b, { from: addDays(b.day, 1) })).toEqual([
      '09:00',
      '09:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
      '16:00',
      '16:30',
    ]);
    await o.post(`/clinic/branches/${b.c.branchId}/exceptions`, {
      kind: 'CLOSED',
      startDate: addDays(b.day, 2),
      reason: 'Holiday',
    });
    expect(await startsOf(h, b, { from: addDays(b.day, 2) })).toEqual([]);
    await o.post(`/clinic/doctor-assignments/${b.assignmentId}/exceptions`, {
      kind: 'CLOSED',
      startDate: addDays(b.day, 3),
      reason: 'Leave',
    });
    expect(await startsOf(h, b, { from: addDays(b.day, 3) })).toEqual([]);
    await o.post(`/clinic/doctor-assignments/${b.assignmentId}/exceptions`, {
      kind: 'UNAVAILABLE',
      startDate: addDays(b.day, 4),
      start: '09:00',
      end: '12:00',
      reason: 'Meeting',
    });
    await o.post(`/clinic/doctor-assignments/${b.assignmentId}/exceptions`, {
      kind: 'EXTRA',
      startDate: addDays(b.day, 4),
      start: '18:00',
      end: '19:00',
      reason: 'Evening clinic',
    });
    expect(await startsOf(h, b, { from: addDays(b.day, 4) })).toEqual([
      '12:00',
      '12:30',
      '16:00',
      '16:30',
      '18:00',
      '18:30',
    ]);
  });

  it('service duration, per-doctor override and buffer shape the slots', async () => {
    const o = clinic(h, b);
    await o.put(`/clinic/branches/${b.c.branchId}/services/${b.serviceId}`, {
      priceMinor: 20000,
      durationMinutes: 45,
      bufferMinutes: 15,
    });
    expect(await startsOf(h, b)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
    ]);
    await o.put(`/clinic/doctor-assignments/${b.assignmentId}/services/${b.serviceId}`, {
      durationMinutes: 60,
    });
    const res = await slots(h, b);
    expect(res.slots.at(-1)?.local).toMatchObject({ start: '11:30', end: '12:30' }); // 60 + 15 must fit by 13:00
    // Buffer blocks the doctor after a booked appointment.
    const p = await patient(h);
    await bookSlot(h, b, p, '09:00');
    expect((await startsOf(h, b))[0]).toBe('10:30'); // 09:00–10:00 + 15 min buffer → next start on the grid after 10:15
  });

  it('pending holds and confirmed bookings remove the slot; an expired hold releases it without the worker', async () => {
    await clinic(h, b).put('/clinic/booking-settings', { confirmationTtlMinutes: 5 }); // stay inside token lifetime
    const p = await patient(h);
    const id = await bookSlot(h, b, p, '09:00');
    expect(await startsOf(h, b)).not.toContain('09:00');
    const deadline = (
      await h.db.query<{ confirmation_deadline: Date }>(
        'SELECT confirmation_deadline FROM bookings WHERE id = ?',
        [id],
      )
    )[0];
    h.clock.advance((deadline?.confirmation_deadline.getTime() ?? 0) - h.clock().getTime() + 1000);
    expect(await startsOf(h, b)).toContain('09:00'); // still PENDING in the table, but the hold is over
    const second = await bookSlot(h, b, await patient(h), '09:30');
    expect((await confirm(h, b, second)).status).toBe(200);
    expect(await startsOf(h, b)).not.toContain('09:30');
  });

  it("the doctor's booking at ANOTHER clinic removes overlapping slots here without revealing it", async () => {
    const other = await bookableClinic(h, admin, { doctor: b.doctor, work: ['09:00', '13:00'] });
    // Same doctor in two clinics: recurring schedules may overlap (Task 04, OD-21), bookings may not.
    await bookSlot(h, other, await patient(h), '10:00');
    const here = await slots(h, b);
    expect(here.slots.map((s) => s.local.start)).toEqual(ALL.filter((s) => s !== '10:00'));
    expect(JSON.stringify(here)).not.toContain(other.c.clinicId);
  });

  it('patient conflicts are excluded for an identified patient (/me/availability)', async () => {
    const p = await patient(h);
    const elsewhere = await bookableClinic(h, admin);
    await bookSlot(h, elsewhere, p, '11:00');
    expect(await startsOf(h, b)).toContain('11:00'); // anonymous
    expect(await startsOf(h, b, { as: p })).not.toContain('11:00'); // the patient is busy then
  });

  it('inactive service, inactive branch, ineligible doctor, gate and subscription restrictions', async () => {
    const o = clinic(h, b);
    await o.patch(`/clinic/members/${b.doctor.membershipId}/status`, {
      status: 'SUSPENDED',
      reason: 'Investigation',
    });
    expect((await slots(h, b)).slots).toEqual([]);
    await o.patch(`/clinic/members/${b.doctor.membershipId}/status`, {
      status: 'ACTIVE',
      reason: 'Resolved',
    });
    expect((await slots(h, b)).slots).toHaveLength(8);

    await as(h, admin).post(`/admin/clinics/${b.c.clinicId}/suspend`, {
      scope: 'NEW_OPERATIONS',
      reason: 'Fines',
    });
    expect(await slots(h, b)).toMatchObject({
      available: false,
      reason: 'NOT_ACCEPTING_BOOKINGS',
      slots: [],
    });
    await as(h, admin).post(`/admin/clinics/${b.c.clinicId}/reinstate`, { reason: 'Paid' });
    await as(h, admin).post(`/admin/clinics/${b.c.clinicId}/subscription/suspend`, {
      reason: 'Chargeback',
    });
    expect((await slots(h, b)).reason).toBe('NOT_ACCEPTING_BOOKINGS');
    await as(h, admin).post(`/admin/clinics/${b.c.clinicId}/subscription/reactivate`, {
      reason: 'Resolved',
    });
    await o.post(`/clinic/branches/${b.c.branchId}/deactivate`, {});
    expect((await slots(h, b)).reason).toBe('NOT_ACCEPTING_BOOKINGS');
    await o.post(`/clinic/branches/${b.c.branchId}/activate`, {});
    await o.patch(`/clinic/services/${b.serviceId}`, { status: 'INACTIVE' });
    expect((await availability(h, b)).status).toBe(404);
  });

  it('DST: slots follow the branch zone and never get a wrong real length', async () => {
    const ny = await bookableClinic(h, admin, {
      timeZone: 'America/New_York',
      work: ['00:00', '04:00'],
      settings: { maxHorizonDays: 180 },
    });
    const spring = nextTransitionDate('America/New_York', ny.t0, 'forward');
    expect(addDays(ny.t0, 180) >= spring).toBe(true); // inside the 180-day horizon
    const res = await slots(h, ny, { from: spring });
    // 02:00–02:59 do not exist; 01:30–02:00 is a real 30 minutes; nothing has a wrong length.
    expect(res.slots.map((s) => s.local.start)).toEqual([
      '00:00',
      '00:30',
      '01:00',
      '01:30',
      '03:00',
      '03:30',
    ]);
    expect(
      res.slots.every((s) => Date.parse(s.endsAt) - Date.parse(s.startsAt) === 30 * 60_000),
    ).toBe(true);
    expect(res.slots[2]?.startsAt).toBe(`${spring}T06:00:00.000Z`); // 01:00 EST
    // The fall-back day lies beyond the platform's 180-day horizon; its rule is unit-tested
    // (policy.test.ts: the repeated hour never yields a 90-minute "30-minute" slot).
  });

  it('bounds and modes: ≤ 14 days, queue mode not available yet, unknown ids 404', async () => {
    expect(code(await availability(h, b, { to: addDays(b.day, 14) }))).toBe('VALIDATION_ERROR');
    expect(code(await availability(h, b, { extra: '&mode=QUEUE' }))).toBe(
      'BOOKING_MODE_NOT_SUPPORTED',
    );
    expect(code(await clinic(h, b).put('/clinic/booking-settings', { queueEnabled: true }))).toBe(
      'QUEUE_MODE_NOT_AVAILABLE',
    );
    const foreign = await bookableClinic(h, admin);
    const res = await h
      .http()
      .get(
        `/api/v1/availability?clinicId=${b.c.clinicId}&branchId=${foreign.c.branchId}&serviceId=${b.serviceId}&from=${b.day}&to=${b.day}`,
      );
    expect(res.status).toBe(404);
  });

  it('a second doctor adds slots; another doctor-assignment id of the clinic filters to that doctor', async () => {
    const d2 = await verifiedDoctor(h, b.c);
    const a2 = await assign(h, b.c, b.c.branchId, d2.membershipId);
    await doctorSchedule(h, b.c, a2, { effectiveFrom: b.t0, periods: every('15:00', '16:00') });
    await clinic(h, b).put(`/clinic/doctor-assignments/${a2}/services/${b.serviceId}`, {});
    expect((await slots(h, b)).slots).toHaveLength(10);
    expect(
      (await slots(h, b, { extra: `&assignmentId=${a2}` })).slots.map((s) => s.local.start),
    ).toEqual(['15:00', '15:30']);
  });
});
