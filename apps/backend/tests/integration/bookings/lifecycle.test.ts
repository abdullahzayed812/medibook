import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import { addStaff, adminSession, as, code, data } from '../support/platform.js';
import {
  bookableClinic,
  bookSlot,
  clinic,
  confirm,
  key,
  patient,
  slots,
  startsOf,
  statusOf,
  type BookableClinic,
} from '../support/bookings.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let b: BookableClinic;
let p: LoggedIn & { phone: string };
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  // 5-minute confirmation TTL keeps clock jumps inside the 15-minute access-token lifetime.
  b = await bookableClinic(h, admin, { settings: { confirmationTtlMinutes: 5 } });
  p = await patient(h);
});

const sweep = () => h.container.services.bookings.expireOverdue();
const history = async (id: string) =>
  (
    await h.db.query<{ to_status: string; actor_kind: string }>(
      'SELECT to_status, actor_kind FROM booking_status_history WHERE booking_id = ? ORDER BY id',
      [id],
    )
  ).map((r) => `${r.to_status}:${r.actor_kind}`);
const pastDeadline = () => {
  h.clock.advance(5 * 60_000 + 1000);
};

describe('confirmation, rejection and expiration', () => {
  it('confirms a pending request; repeat is refused; only authorized clinic users may confirm', async () => {
    const id = await bookSlot(h, b, p);
    const doctorApi = as(h, b.doctor.session, { clinicId: b.c.clinicId });
    expect(code(await doctorApi.post(`/clinic/bookings/${id}/confirm`, {}))).toBe('FORBIDDEN'); // view only
    const other = await bookableClinic(h, admin);
    expect((await clinic(h, other).post(`/clinic/bookings/${id}/confirm`, {})).status).toBe(404); // tenant
    const res = await confirm(h, b, id);
    expect(res.status).toBe(200);
    expect(data<{ status: string }>(res).status).toBe('CONFIRMED');
    expect(code(await confirm(h, b, id))).toBe('INVALID_TRANSITION');
    expect(await history(id)).toEqual(['PENDING_CONFIRMATION:SELF', 'CONFIRMED:STAFF']);
    const receptionist = await addStaff(h, b.c.owner, b.c.clinicId, 'RECEPTIONIST');
    const id2 = await bookSlot(h, b, await patient(h), '10:00');
    expect(
      (
        await as(h, receptionist.session, { clinicId: b.c.clinicId }).post(
          `/clinic/bookings/${id2}/confirm`,
          {},
        )
      ).status,
    ).toBe(200);
  });

  it('an overdue request cannot be confirmed even if the worker never ran', async () => {
    const id = await bookSlot(h, b, p);
    pastDeadline();
    expect(await statusOf(h, id)).toBe('PENDING_CONFIRMATION'); // no worker yet
    expect(code(await confirm(h, b, id))).toBe('BOOKING_EXPIRED');
    expect(await statusOf(h, id)).toBe('EXPIRED');
    expect(await sweep()).toBe(0); // already expired: nothing left
    expect(await history(id)).toEqual(['PENDING_CONFIRMATION:SELF', 'EXPIRED:SYSTEM']);
  });

  it('rejection needs a reason and releases capacity exactly once', async () => {
    const id = await bookSlot(h, b, p);
    expect(code(await clinic(h, b).post(`/clinic/bookings/${id}/reject`, {}))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      (await clinic(h, b).post(`/clinic/bookings/${id}/reject`, { reason: 'Doctor unavailable' }))
        .status,
    ).toBe(200);
    expect(
      code(await clinic(h, b).post(`/clinic/bookings/${id}/reject`, { reason: 'Again please' })),
    ).toBe('INVALID_TRANSITION');
    expect(await startsOf(h, b)).toContain('09:00');
    expect(await history(id)).toEqual(['PENDING_CONFIRMATION:SELF', 'REJECTED:STAFF']);
    const [row] = await h.db.query<{ status_reason: string }>(
      'SELECT status_reason FROM bookings WHERE id = ?',
      [id],
    );
    expect(row?.status_reason).toBe('Doctor unavailable');
    const events = await h.db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM domain_events WHERE aggregate_id = ? ORDER BY id`,
      [id],
    );
    expect(events.map((e) => e.event_type)).toEqual(['booking.requested', 'booking.rejected']);
    expect(JSON.stringify(events)).not.toMatch(/Consultation|Doctor unavailable|Synthetic/); // no names, notes or reasons
  });

  it('concurrent confirmation and expiration (and duplicate workers) produce exactly one outcome', async () => {
    for (let round = 0; round < 3; round++) {
      await h.reset();
      admin = await adminSession(h);
      b = await bookableClinic(h, admin, { settings: { confirmationTtlMinutes: 5 } });
      const id = await bookSlot(h, b, await patient(h));
      pastDeadline();
      const [c1, s1, s2] = await Promise.all([confirm(h, b, id), sweep(), sweep()]);
      expect(c1.status).toBe(409);
      expect(s1 + s2).toBeLessThanOrEqual(1);
      expect(await statusOf(h, id)).toBe('EXPIRED');
      expect((await history(id)).filter((x) => x.startsWith('EXPIRED'))).toHaveLength(1);
    }
    // Before the deadline: confirm wins, the sweep finds nothing.
    const id = await bookSlot(h, b, await patient(h), '10:00');
    const [c, s] = await Promise.all([confirm(h, b, id), sweep()]);
    expect(c.status).toBe(200);
    expect(s).toBe(0);
  });
});

describe('cancellation', () => {
  it('patient cancels within policy (pending: always); clinic cancels with reason; repeats are refused', async () => {
    const pending = await bookSlot(h, b, p);
    expect((await as(h, p).post(`/me/bookings/${pending}/cancel`, {})).status).toBe(200);
    expect(code(await as(h, p).post(`/me/bookings/${pending}/cancel`, {}))).toBe(
      'INVALID_TRANSITION',
    );
    expect(await startsOf(h, b)).toContain('09:00');
    const confirmed = await bookSlot(h, b, p, '10:00');
    await confirm(h, b, confirmed);
    expect(
      (await as(h, p).post(`/me/bookings/${confirmed}/cancel`, { reason: 'Travel' })).status,
    ).toBe(200); // 2 days ahead > 24 h
    const byClinic = await bookSlot(h, b, p, '11:00');
    await confirm(h, b, byClinic);
    expect(code(await clinic(h, b).post(`/clinic/bookings/${byClinic}/cancel`, {}))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      (await clinic(h, b).post(`/clinic/bookings/${byClinic}/cancel`, { reason: 'Doctor sick' }))
        .status,
    ).toBe(200);
    expect(await history(byClinic)).toEqual([
      'PENDING_CONFIRMATION:SELF',
      'CONFIRMED:STAFF',
      'CANCELLED:STAFF',
    ]);
  });

  it('outside the snapshotted notice period the patient cannot cancel; a later policy change does not apply', async () => {
    await clinic(h, b).put('/clinic/booking-settings', { cancelMinNoticeMinutes: 4 * 24 * 60 });
    const id = await bookSlot(h, b, p); // 2 days ahead, policy requires 4 days
    await confirm(h, b, id);
    await clinic(h, b).put('/clinic/booking-settings', { cancelMinNoticeMinutes: 0 }); // too late for this booking
    const res = await as(h, p).post(`/me/bookings/${id}/cancel`, { reason: 'Changed my mind' });
    expect(code(res)).toBe('CANCELLATION_NOT_ALLOWED');
    expect(
      data<{ cancellationPolicy: { minNoticeMinutes: number } }>(
        await as(h, p).get(`/me/bookings/${id}`),
      ).cancellationPolicy.minNoticeMinutes,
    ).toBe(5760);
    // A new booking takes the new policy.
    const later = await bookSlot(h, b, p, '10:00');
    await confirm(h, b, later);
    expect((await as(h, p).post(`/me/bookings/${later}/cancel`, {})).status).toBe(200);
  });

  it('other patients cannot cancel or even see the booking', async () => {
    const id = await bookSlot(h, b, p);
    const stranger = await patient(h);
    expect((await as(h, stranger).post(`/me/bookings/${id}/cancel`, {})).status).toBe(404);
    expect((await as(h, stranger).get(`/me/bookings/${id}`)).status).toBe(404);
    expect(await statusOf(h, id)).toBe('PENDING_CONFIRMATION');
  });
});

describe('rescheduling', () => {
  const reschedule = (s: LoggedIn, id: string, startsAt: string, k = key()) =>
    as(h, s).post(`/me/bookings/${id}/reschedule`, { startsAt }).set('Idempotency-Key', k);
  const at = async (start: string) =>
    (await slots(h, b)).slots.find((x) => x.local.start === start)?.startsAt ?? '';

  it('accepted: the original stays confirmed until the replacement is confirmed, then is superseded atomically', async () => {
    const original = await bookSlot(h, b, p, '09:00');
    await confirm(h, b, original);
    const res = await reschedule(p, original, await at('11:00'));
    expect(res.status).toBe(201);
    const replacement = data<{ id: string; rescheduleOfBookingId: string }>(res);
    expect(replacement.rescheduleOfBookingId).toBe(original);
    expect(await statusOf(h, original)).toBe('CONFIRMED');
    expect(await startsOf(h, b)).not.toContain('11:00'); // replacement holds capacity
    expect(await startsOf(h, b)).not.toContain('09:00'); // original still holds its time
    expect((await confirm(h, b, replacement.id)).status).toBe(200);
    expect(await statusOf(h, original)).toBe('RESCHEDULED');
    expect(await statusOf(h, replacement.id)).toBe('CONFIRMED');
    expect(
      await h.db.query('SELECT superseded_by_booking_id FROM bookings WHERE id = ?', [original]),
    ).toEqual([{ superseded_by_booking_id: replacement.id }]);
    expect(await startsOf(h, b)).toContain('09:00');
  });

  it('rejected or expired replacements leave the original untouched; moving within an overlapping time works', async () => {
    const original = await bookSlot(h, b, p, '09:00');
    await confirm(h, b, original);
    const r1 = data<{ id: string }>(await reschedule(p, original, await at('10:00')));
    await clinic(h, b).post(`/clinic/bookings/${r1.id}/reject`, {
      reason: 'Fully booked that hour',
    });
    expect(await statusOf(h, original)).toBe('CONFIRMED');
    const r2 = data<{ id: string }>(await reschedule(p, original, await at('10:30')));
    pastDeadline();
    await sweep();
    expect(await statusOf(h, r2.id)).toBe('EXPIRED');
    expect(await statusOf(h, original)).toBe('CONFIRMED');
    expect(
      await h.db.query('SELECT superseded_by_booking_id FROM bookings WHERE id = ?', [original]),
    ).toEqual([{ superseded_by_booking_id: null }]);
  });

  it('only one pending replacement at a time, also under concurrency; cancelling the original cancels it', async () => {
    const original = await bookSlot(h, b, p, '09:00');
    await confirm(h, b, original);
    const [s1, s2, s3] = [await at('10:00'), await at('11:00'), await at('12:00')];
    const race = await Promise.all([
      reschedule(p, original, s1),
      reschedule(p, original, s2),
      reschedule(p, original, s3),
    ]);
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expect(race.filter((r) => r.status === 409)).toHaveLength(2);
    const pending = race.find((r) => r.status === 201);
    expect(
      (await as(h, p).post(`/me/bookings/${original}/cancel`, { reason: 'No longer needed' }))
        .status,
    ).toBe(200);
    if (pending === undefined) throw new Error('no replacement won');
    expect(await statusOf(h, data<{ id: string }>(pending).id)).toBe('CANCELLED');
  });

  it('a failed confirmation (conflict) keeps the original and its capacity unchanged', async () => {
    const original = await bookSlot(h, b, p, '09:00');
    await confirm(h, b, original);
    const r = data<{ id: string }>(await reschedule(p, original, await at('12:00')));
    // The doctor's schedule is shortened before the clinic confirms: 12:00 is now outside.
    const sched = data<{ id: string }[]>(
      await clinic(h, b).get(`/clinic/doctor-assignments/${b.assignmentId}/schedules`),
    )[0];
    await clinic(h, b).post(`/clinic/schedules/${sched?.id}/revisions`, {
      effectiveFrom: b.t0,
      periods: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((day) => ({
        day,
        start: '09:00',
        end: '11:00',
      })),
    });
    expect(code(await confirm(h, b, r.id))).toBe('SLOT_UNAVAILABLE');
    expect(await statusOf(h, original)).toBe('CONFIRMED');
    expect(await statusOf(h, r.id)).toBe('PENDING_CONFIRMATION');
    expect(await startsOf(h, b)).not.toContain('09:00');
  });
});
