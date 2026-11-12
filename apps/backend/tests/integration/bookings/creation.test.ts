import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import { adminSession, as, code, data } from '../support/platform.js';
import {
  book,
  bookableClinic,
  bookSlot,
  guestToken,
  key,
  patient,
  slotBody,
  slots,
  type BookableClinic,
} from '../support/bookings.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let b: BookableClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  b = await bookableClinic(h, admin);
});

interface View {
  id: string;
  status: string;
  patient: { personId: string; displayName: string };
  bookedBy: { kind: string; relationship: string | null };
  price: { amountMinor: number; currency: string };
  service: { name: { en: string | null } };
  doctor: { displayName: string };
  cancellationPolicy: { minNoticeMinutes: number };
}
const first = async () =>
  (await slots(h, b)).slots[0] ??
  (() => {
    throw new Error('no slot');
  })();

describe('booking creation', () => {
  it('an authenticated patient books for themself: pending request, snapshots, profile, PATIENT role, history', async () => {
    const p = await patient(h);
    const slot = await first();
    const res = await book(h, p, slotBody(b, slot, { note: 'First visit' }));
    expect(res.status).toBe(201);
    const v = data<View>(res);
    expect(v).toMatchObject({
      status: 'PENDING_CONFIRMATION',
      bookedBy: { kind: 'SELF', relationship: null },
      price: { amountMinor: 20000, currency: 'EGP' },
      service: { name: { en: 'Consultation' } },
      doctor: { displayName: 'Dr. Synthetic Example' },
      cancellationPolicy: { minNoticeMinutes: 1440 },
    });
    const [row] = await h.db.query<{
      patient_profile_id: string;
      person_id: string;
      doctor_display_name: string;
    }>('SELECT patient_profile_id, person_id, doctor_display_name FROM bookings WHERE id = ?', [
      v.id,
    ]);
    expect(
      await h.db.query('SELECT user_id FROM patient_profiles WHERE id = ?', [
        row?.patient_profile_id ?? '',
      ]),
    ).toEqual([{ user_id: p.userId }]);
    expect(
      await h.db.query(`SELECT role_code FROM user_global_roles WHERE user_id = ?`, [p.userId]),
    ).toEqual([{ role_code: 'PATIENT' }]);
    expect(
      await h.db.query('SELECT to_status FROM booking_status_history WHERE booking_id = ?', [v.id]),
    ).toEqual([{ to_status: 'PENDING_CONFIRMATION' }]);
    // Snapshot survives a rename / reprice of the service.
    await as(h, b.c.owner, { clinicId: b.c.clinicId }).patch(`/clinic/services/${b.serviceId}`, {
      nameEn: 'Renamed',
    });
    await as(h, b.c.owner, { clinicId: b.c.clinicId }).put(
      `/clinic/branches/${b.c.branchId}/services/${b.serviceId}`,
      { priceMinor: 99900, durationMinutes: 30 },
    );
    expect(data<View>(await as(h, p).get(`/me/bookings/${v.id}`))).toMatchObject({
      service: { name: { en: 'Consultation' } },
      price: { amountMinor: 20000 },
    });
  });

  it('guest booking: verified phone, no account, token-bound access, later claimed by the account', async () => {
    const g = await guestToken(h);
    const slot = await first();
    const res = await h
      .http()
      .post('/api/v1/guest/bookings')
      .set('X-Guest-Token', g.token)
      .set('Idempotency-Key', key())
      .send(slotBody(b, slot, { patient: { displayName: 'Guest Example' } }));
    expect(res.status).toBe(201);
    const id = data<View>(res).id;
    expect(data<View>(res).bookedBy.kind).toBe('GUEST');
    expect(await h.db.query('SELECT id FROM users WHERE phone_e164 = ?', [g.phone])).toEqual([]); // no account
    expect(
      await h.db.query(
        `SELECT user_id FROM patient_profiles pp JOIN bookings b ON b.patient_profile_id = pp.id WHERE b.id = ?`,
        [id],
      ),
    ).toEqual([{ user_id: null }]);
    expect(
      (await h.http().get('/api/v1/guest/bookings').set('X-Guest-Token', g.token)).status,
    ).toBe(200);
    expect(code(await h.http().get(`/api/v1/guest/bookings/${id}`))).toBe('GUEST_SESSION_INVALID');
    expect(
      code(await h.http().get(`/api/v1/guest/bookings/${id}`).set('X-Guest-Token', 'x'.repeat(43))),
    ).toBe('GUEST_SESSION_INVALID');
    const other = await guestToken(h);
    expect(
      (await h.http().get(`/api/v1/guest/bookings/${id}`).set('X-Guest-Token', other.token)).status,
    ).toBe(404);
    // A login code can never be used as guest proof (purpose-bound challenges).
    await h.clearCooldowns();
    const login = await h.http().post('/api/v1/auth/otp/request').send({ phone: g.phone });
    const loginChallenge = data<{ challengeId: string }>(login).challengeId;
    expect(
      code(
        await h
          .http()
          .post('/api/v1/guest/verifications/verify')
          .send({ challengeId: loginChallenge, phone: g.phone, code: h.otp.lastCodeFor(g.phone) }),
      ),
    ).toBe('OTP_INVALID');
    // Task 05.1: the phone alone proves nothing; the one-time claim code does.
    const claimCode =
      (res.body as { guestAccess?: { claimCode: string } }).guestAccess?.claimCode ?? '';
    expect(claimCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const account = await patient(h, g.phone);
    expect((await as(h, account).get(`/me/bookings/${id}`)).status).toBe(404); // same phone ≠ owner
    expect(
      data<{ bookings: number }>(
        await as(h, account).post('/me/guest-bookings/claim', { claimCode }),
      ).bookings,
    ).toBe(1);
    expect(data<View>(await as(h, account).get(`/me/bookings/${id}`)).id).toBe(id);
    // The clinic's patient record is not re-linked or merged by a claim.
    expect(
      await h.db.query(
        `SELECT user_id FROM patient_profiles pp JOIN bookings b ON b.patient_profile_id = pp.id WHERE b.id = ?`,
        [id],
      ),
    ).toEqual([{ user_id: null }]);
  });

  it('booking for a dependent (guardian of a minor) and for a consenting account; no medical-record access implied', async () => {
    const parent = await patient(h);
    const child = data<{ personId: string }>(
      await as(h, parent).post('/me/dependents', {
        displayName: 'Child Example',
        birthDate: '2018-05-01',
        relationship: 'GUARDIAN',
      }),
    );
    const id = await bookSlot(h, b, parent, '09:00', { personId: child.personId });
    const v = data<View>(await as(h, parent).get(`/me/bookings/${id}`));
    expect(v).toMatchObject({
      patient: { displayName: 'Child Example' },
      bookedBy: { kind: 'DELEGATE', relationship: 'GUARDIAN' },
    });
    expect(
      await h.db.query(
        `SELECT user_id FROM patient_profiles pp JOIN bookings b ON b.patient_profile_id = pp.id WHERE b.id = ?`,
        [id],
      ),
    ).toEqual([{ user_id: null }]); // patient without login
    expect(
      await h.db.query(`SELECT scope FROM booking_delegations WHERE person_id = ?`, [
        child.personId,
      ]),
    ).toEqual([{ scope: 'BOOKING' }]);

    // Consent: an adult account allows a spouse to book for them.
    const spouse = await patient(h);
    const adult = await patient(h);
    expect(
      (await as(h, adult).post('/me/delegates', { phone: spouse.phone, relationship: 'SPOUSE' }))
        .status,
    ).toBe(201);
    const adultPerson = data<{ personId: string; self: boolean }[]>(
      await as(h, adult).get('/me/booking-persons'),
    ).find((x) => x.self)?.personId;
    const forAdult = await bookSlot(h, b, spouse, '10:00', { personId: adultPerson });
    expect(data<View>(await as(h, adult).get(`/me/bookings/${forAdult}`)).bookedBy).toEqual({
      kind: 'DELEGATE',
      relationship: 'SPOUSE',
    });
    // Revoking consent removes the spouse's access immediately.
    const delegation = data<{ delegationId: string }[]>(await as(h, adult).get('/me/delegates'))[0];
    expect(
      (await as(h, adult).post(`/me/delegations/${delegation?.delegationId}/revoke`, {})).status,
    ).toBe(204);
    expect((await as(h, spouse).get(`/me/bookings/${forAdult}`)).status).toBe(404);
  });

  it('rejects invalid authority: unknown or foreign persons, adult "guardian", missing authority statement', async () => {
    const p = await patient(h);
    const stranger = await patient(h);
    const strangerPerson = data<{ personId: string }[]>(
      await as(h, stranger).get('/me/booking-persons'),
    )[0]?.personId;
    expect(
      (await book(h, p, slotBody(b, await first(), { personId: strangerPerson }))).status,
    ).toBe(404);
    expect(
      code(
        await as(h, p).post('/me/dependents', {
          displayName: 'Adult',
          birthDate: '1980-01-01',
          relationship: 'GUARDIAN',
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      code(
        await as(h, p).post('/me/dependents', { displayName: 'Uncle', relationship: 'RELATIVE' }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await as(h, p).post('/me/dependents', {
          displayName: 'Uncle',
          relationship: 'RELATIVE',
          authorityStatement: 'Registered carer per family arrangement',
        })
      ).status,
    ).toBe(201);
  });

  it('duplicates, invalid slots and taken slots are rejected', async () => {
    const p = await patient(h);
    const slot = await first();
    expect((await book(h, p, slotBody(b, slot))).status).toBe(201);
    expect(code(await book(h, p, slotBody(b, slot)))).toBe('PATIENT_CONFLICT'); // same patient, same time
    expect(code(await book(h, await patient(h), slotBody(b, slot)))).toBe('SLOT_UNAVAILABLE'); // doctor taken
    const misaligned = {
      ...slot,
      startsAt: new Date(Date.parse(slot.startsAt) + 10 * 60_000).toISOString(),
    };
    expect(code(await book(h, await patient(h), slotBody(b, misaligned)))).toBe('SLOT_UNAVAILABLE');
    const outside = {
      ...slot,
      startsAt: new Date(Date.parse(slot.startsAt) + 8 * 3_600_000).toISOString(),
    };
    expect(code(await book(h, await patient(h), slotBody(b, outside)))).toBe('SLOT_UNAVAILABLE');
    // "Expired availability data": the client still shows 09:30, but it was taken meanwhile.
    const stale = (await slots(h, b)).slots[0];
    await book(h, await patient(h), slotBody(b, stale ?? slot));
    expect(code(await book(h, await patient(h), slotBody(b, stale ?? slot)))).toBe(
      'SLOT_UNAVAILABLE',
    );
    expect((await as(h, p).post('/me/bookings', slotBody(b, slot))).status).toBe(400); // Idempotency-Key required
  });

  it('idempotency: replay returns the original result; a different payload with the same key conflicts', async () => {
    const p = await patient(h);
    const [s1, s2] = (await slots(h, b)).slots;
    const k = key();
    const a = await book(h, p, slotBody(b, s1 ?? (await first())), k);
    const again = await book(h, p, slotBody(b, s1 ?? (await first())), k);
    expect(again.status).toBe(201);
    expect(data<View>(again).id).toBe(data<View>(a).id);
    expect(code(await book(h, p, slotBody(b, s2 ?? (await first())), k))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    // Concurrent duplicates with one key: one execution, identical answers.
    const k2 = key();
    const body2 = slotBody(b, s2 ?? (await first()));
    const p2 = await patient(h);
    const parallel = await Promise.all([1, 2, 3].map(() => book(h, p2, body2, k2)));
    expect(parallel.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(parallel.map((r) => data<View>(r).id)).size).toBe(1);
    expect(
      await h.db.query(
        'SELECT id FROM bookings WHERE person_id = (SELECT person_id FROM bookings WHERE id = ?)',
        [data<View>(parallel[0] ?? a).id],
      ),
    ).toHaveLength(1);
    // Keys are scoped per actor: another patient reusing the key is independent.
    expect(code(await book(h, await patient(h), slotBody(b, s2 ?? (await first())), k))).toBe(
      'SLOT_UNAVAILABLE',
    );
  });

  it('cross-tenant id manipulation: a doctor or service of another clinic cannot be combined', async () => {
    const p = await patient(h);
    const other = await bookableClinic(h, admin);
    const slot = await first();
    expect((await book(h, p, slotBody(b, slot, { assignmentId: other.assignmentId }))).status).toBe(
      409,
    );
    expect((await book(h, p, slotBody(b, slot, { serviceId: other.serviceId }))).status).toBe(404);
    expect((await book(h, p, slotBody(b, slot, { clinicId: other.c.clinicId }))).status).toBe(404);
    expect(await h.db.query('SELECT id FROM bookings')).toEqual([]);
  });
});
