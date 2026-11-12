import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import { addBranch, assign, branchHours, every } from '../support/setup.js';
import { addStaff, adminSession, as, code, data } from '../support/platform.js';
import {
  book,
  bookableClinic,
  bookSlot,
  clinic,
  confirm,
  patient,
  slotBody,
  slots,
  statusOf,
  type BookableClinic,
  type Slot,
} from '../support/bookings.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let a: BookableClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  a = await bookableClinic(h, admin);
});

const slotAt = async (b: BookableClinic, start: string): Promise<Slot> => {
  const s = (await slots(h, b)).slots.find((x) => x.local.start === start);
  if (s === undefined) throw new Error(`no slot ${start}`);
  return s;
};

describe('doctor conflicts (global across clinics)', () => {
  it('same doctor, same time, same clinic: the second patient is refused', async () => {
    const s = await slotAt(a, '09:00');
    expect((await book(h, await patient(h), slotBody(a, s))).status).toBe(201);
    expect(code(await book(h, await patient(h), slotBody(a, s)))).toBe('SLOT_UNAVAILABLE');
  });

  it('same doctor, overlapping time in another clinic: refused without revealing the other clinic', async () => {
    // Clinic B: same doctor, 45-minute service, slots on a 15-minute grid → B 09:15–10:00 overlaps A 09:30.
    const b = await bookableClinic(h, admin, {
      doctor: a.doctor,
      duration: 45,
      settings: { slotIntervalMinutes: 15 },
    });
    const inA = await slotAt(a, '09:30');
    const inB = await slotAt(b, '09:15');
    expect((await book(h, await patient(h), slotBody(b, inB))).status).toBe(201);
    const res = await book(h, await patient(h), slotBody(a, inA));
    expect(code(res)).toBe('SLOT_UNAVAILABLE');
    const text = JSON.stringify(res.body);
    for (const secret of [b.c.clinicId, b.serviceId, b.assignmentId, 'Consultation', 'details'])
      expect(text).not.toContain(secret);
    // Non-overlapping appointments in the two clinics are fine.
    expect((await book(h, await patient(h), slotBody(a, await slotAt(a, '10:00')))).status).toBe(
      201,
    );
  });

  it('confirmation re-checks the global doctor conflict inside its transaction', async () => {
    const b = await bookableClinic(h, admin, {
      doctor: a.doctor,
      settings: { confirmationTtlMinutes: 5 },
    });
    await clinic(h, a).put('/clinic/booking-settings', { confirmationTtlMinutes: 5 });
    const inA = await bookSlot(h, a, await patient(h), '09:00');
    // The hold in A expires; B books the same doctor at the same time; A then tries to confirm.
    h.clock.advance(5 * 60_000 + 1000);
    const inB = await bookSlot(h, b, await patient(h), '09:00');
    expect(code(await confirm(h, a, inA))).toBe('BOOKING_EXPIRED');
    expect((await confirm(h, b, inB)).status).toBe(200);
  });
});

describe('patient conflicts', () => {
  it('overlapping appointments of the same patient are refused across clinics; non-overlapping ones are allowed', async () => {
    const p = await patient(h);
    const other = await bookableClinic(h, admin);
    await bookSlot(h, a, p, '09:00');
    expect(code(await book(h, p, slotBody(other, await slotAt(other, '09:00'))))).toBe(
      'PATIENT_CONFLICT',
    );
    expect((await book(h, p, slotBody(other, await slotAt(other, '09:30')))).status).toBe(201);
    expect((await book(h, p, slotBody(a, await slotAt(a, '11:00')))).status).toBe(201); // same clinic, later
    // A dependent is a different person: the parent's own appointment does not block the child.
    const child = data<{ personId: string }>(
      await as(h, p).post('/me/dependents', {
        displayName: 'Child',
        birthDate: '2019-01-01',
        relationship: 'GUARDIAN',
      }),
    );
    expect(
      (
        await book(
          h,
          p,
          slotBody(other, await slotAt(other, '10:00'), { personId: child.personId }),
        )
      ).status,
    ).toBe(201);
  });
});

describe('concurrency', () => {
  it('many patients racing for the last slot: exactly one wins', async () => {
    const s = await slotAt(a, '09:00');
    const patients = await Promise.all([1, 2, 3, 4, 5, 6].map(() => patient(h)));
    const res = await Promise.all(patients.map((p) => book(h, p, slotBody(a, s))));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => code(r) === 'SLOT_UNAVAILABLE')).toHaveLength(5);
  });

  it('the same doctor booked concurrently in two clinics at overlapping times: exactly one wins', async () => {
    const b = await bookableClinic(h, admin, { doctor: a.doctor });
    for (const start of ['09:00', '10:00', '11:00']) {
      const [x, y] = await Promise.all([
        book(h, await patient(h), slotBody(a, await slotAt(a, start))),
        book(h, await patient(h), slotBody(b, await slotAt(b, start))),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
    }
  });

  it('the same patient booking two clinics at the same time concurrently: exactly one wins', async () => {
    const b = await bookableClinic(h, admin);
    const p = await patient(h);
    await as(h, p).get('/me/booking-persons'); // create the person first (first-use race is tested elsewhere)
    const [x, y] = await Promise.all([
      book(h, p, slotBody(a, await slotAt(a, '09:00'))),
      book(h, p, slotBody(b, await slotAt(b, '09:00'))),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
  });
});

describe('operational policies and security', () => {
  it('FULL / NEW_OPERATIONS suspension blocks new bookings and confirmation, but not rejection or cancellation', async () => {
    const pending = await bookSlot(h, a, await patient(h), '09:00');
    const confirmed = await bookSlot(h, a, await patient(h), '10:00');
    await confirm(h, a, confirmed);
    await as(h, admin).post(`/admin/clinics/${a.c.clinicId}/suspend`, {
      scope: 'NEW_OPERATIONS',
      reason: 'Fines',
    });
    expect(code(await confirm(h, a, pending))).toBe('CLINIC_SUSPENDED');
    expect(
      (
        await clinic(h, a).post(`/clinic/bookings/${pending}/reject`, {
          reason: 'Clinic restricted',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await clinic(h, a).post(`/clinic/bookings/${confirmed}/cancel`, {
          reason: 'Clinic restricted',
        })
      ).status,
    ).toBe(200);
    await as(h, admin).post(`/admin/clinics/${a.c.clinicId}/reinstate`, { reason: 'Paid' });
    await as(h, admin).post(`/admin/clinics/${a.c.clinicId}/suspend`, {
      scope: 'FULL',
      reason: 'Investigation',
    });
    const slot = {
      assignmentId: a.assignmentId,
      startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      endsAt: '',
      local: { date: '', start: '', end: '' },
    };
    expect(code(await book(h, await patient(h), slotBody(a, slot)))).toBe(
      'CLINIC_NOT_ACCEPTING_BOOKINGS',
    );
  });

  it('a restricted subscription blocks new bookings and confirmation (NEW_OPERATION) but patients can still cancel', async () => {
    const p = await patient(h);
    const id = await bookSlot(h, a, p, '09:00');
    await as(h, admin).post(`/admin/clinics/${a.c.clinicId}/subscription/suspend`, {
      reason: 'Chargeback',
    });
    expect(code(await confirm(h, a, id))).toBe('SUBSCRIPTION_INACTIVE');
    expect(
      code(
        await book(
          h,
          await patient(h),
          slotBody(a, {
            assignmentId: a.assignmentId,
            startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            endsAt: '',
            local: { date: '', start: '', end: '' },
          }),
        ),
      ),
    ).toBe('CLINIC_NOT_ACCEPTING_BOOKINGS');
    expect((await as(h, p).post(`/me/bookings/${id}/cancel`, {})).status).toBe(200);
  });

  it('revoking the doctor membership or verification blocks new bookings and confirmation', async () => {
    const id = await bookSlot(h, a, await patient(h), '09:00');
    const slot = await slotAt(a, '10:00');
    await clinic(h, a).patch(`/clinic/members/${a.doctor.membershipId}/status`, {
      status: 'TERMINATED',
      reason: 'Left',
    });
    expect(code(await book(h, await patient(h), slotBody(a, slot)))).toBe('SLOT_UNAVAILABLE');
    expect(code(await confirm(h, a, id))).toBe('BOOKING_NOT_CONFIRMABLE');
    expect(await statusOf(h, id)).toBe('PENDING_CONFIRMATION');
  });

  it('clinic staff see only their clinic and covered branches; ids of other clinics are 404', async () => {
    const id = await bookSlot(h, a, await patient(h), '09:00');
    const other = await bookableClinic(h, admin);
    const o = clinic(h, other);
    for (const path of [
      `/clinic/bookings/${id}`,
      `/clinic/bookings/${id}/confirm`,
      `/clinic/bookings/${id}/reject`,
      `/clinic/bookings/${id}/cancel`,
    ]) {
      const res = path.endsWith(id)
        ? await o.get(path)
        : await o.post(path, { reason: 'Not mine at all' });
      expect(res.status, path).toBe(404);
    }
    expect(data<unknown[]>(await o.get('/clinic/bookings'))).toEqual([]);
    expect(
      code(await as(h, other.c.owner, { clinicId: a.c.clinicId }).get('/clinic/bookings')),
    ).toBe('CLINIC_ACCESS_DENIED');

    // Branch-assigned receptionist of a second branch: does not see the main branch's booking.
    const second = await addBranch(h, a.c, 'Second', 'Africa/Cairo');
    await branchHours(h, a.c, second, { effectiveFrom: a.t0, periods: every('00:00', '24:00') });
    await assign(h, a.c, second, a.doctor.membershipId);
    const r = await addStaff(h, a.c.owner, a.c.clinicId, 'RECEPTIONIST', {
      branchScope: 'ASSIGNED',
      branchIds: [second],
    });
    const rApi = as(h, r.session, { clinicId: a.c.clinicId });
    expect(data<unknown[]>(await rApi.get('/clinic/bookings'))).toEqual([]);
    expect((await rApi.get(`/clinic/bookings/${id}`)).status).toBe(404);
    expect((await rApi.post(`/clinic/bookings/${id}/confirm`, {})).status).toBe(404);
    expect(
      data<unknown[]>(await clinic(h, a).get(`/clinic/bookings?branchId=${a.c.branchId}`)),
    ).toHaveLength(1);
  });

  it('clinic views expose the clinic patient, patients see only their own bookings across clinics', async () => {
    const p = await patient(h);
    const other = await bookableClinic(h, admin);
    const id1 = await bookSlot(h, a, p, '09:00');
    await bookSlot(h, other, p, '11:00');
    const mine = data<{ id: string; clinic: { id: string } }[]>(await as(h, p).get('/me/bookings'));
    expect(mine).toHaveLength(2);
    const inA = data<{ id: string; patient: { contactPhone: string } }[]>(
      await clinic(h, a).get('/clinic/bookings'),
    );
    expect(inA.map((x) => x.id)).toEqual([id1]);
    expect(inA[0]?.patient.contactPhone).toBe(p.phone);
    expect(JSON.stringify(inA)).not.toContain(other.c.clinicId);
  });
});
