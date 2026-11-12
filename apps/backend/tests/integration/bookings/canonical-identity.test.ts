import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import { addStaff, adminSession, as, code, data } from '../support/platform.js';
import {
  book,
  bookableClinic,
  bookSlot,
  confirm,
  guestBook,
  key,
  patient,
  slotBody,
  slots,
  statusOf,
  type BookableClinic,
  type Slot,
} from '../support/bookings.js';

/** Task 05.2: one canonical conflict identity per verified person, across person records. */
const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let a: BookableClinic; // clinic A
let b: BookableClinic; // clinic B (another doctor)
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  a = await bookableClinic(h, admin);
  b = await bookableClinic(h, admin);
});

const slotAt = async (c: BookableClinic, start: string): Promise<Slot> => {
  const s = (await slots(h, c)).slots.find((x) => x.local.start === start);
  if (s === undefined) throw new Error(`no slot ${start}`);
  return s;
};
const claim = (s: LoggedIn, claimCode: string) =>
  as(h, s).post('/me/guest-bookings/claim', { claimCode });
const identityOf = async (personId: string) =>
  (
    await h.db.query<{ identity_id: string }>(
      'SELECT identity_id FROM booking_persons WHERE id = ?',
      [personId],
    )
  )[0]?.identity_id;
const personOfBooking = async (id: string) =>
  (await h.db.query<{ person_id: string }>('SELECT person_id FROM bookings WHERE id = ?', [id]))[0]
    ?.person_id ?? '';
const selfPerson = async (s: LoggedIn) =>
  data<{ personId: string; self: boolean }[]>(await as(h, s).get('/me/booking-persons')).find(
    (p) => p.self,
  )?.personId ?? '';
const linkRows = () =>
  h.db.query<{ status: string; source: string; evidence_type: string }>(
    'SELECT status, source, evidence_type FROM booking_identity_links',
  );

describe('identity linking', () => {
  it('a valid claim links the guest identity to the account; records, profiles and history stay separate and unchanged', async () => {
    const g = await guestBook(h, a); // guest books clinic A 09:00
    const account = await patient(h);
    const self = await selfPerson(account);
    const guestPerson = await personOfBooking(g.id);
    const before = {
      booking: await h.db.query(
        'SELECT person_id, patient_profile_id, actor_kind, actor_user_id, guest_session_id FROM bookings WHERE id = ?',
        [g.id],
      ),
      profiles: await h.db.query(
        'SELECT id, clinic_id, user_id, person_id, display_name FROM patient_profiles ORDER BY id',
      ),
      history: await h.db.query('SELECT * FROM booking_status_history ORDER BY id'),
    };
    expect(await identityOf(guestPerson)).not.toBe(await identityOf(self));
    expect((await claim(account, g.claimCode ?? '')).status).toBe(200);
    expect(await identityOf(guestPerson)).toBe(await identityOf(self)); // one conflict identity
    expect(guestPerson).not.toBe(self); // two person records
    expect(
      await h.db.query(
        'SELECT person_id, patient_profile_id, actor_kind, actor_user_id, guest_session_id FROM bookings WHERE id = ?',
        [g.id],
      ),
    ).toEqual(before.booking);
    expect(
      await h.db.query(
        'SELECT id, clinic_id, user_id, person_id, display_name FROM patient_profiles ORDER BY id',
      ),
    ).toEqual(before.profiles);
    expect(await h.db.query('SELECT * FROM booking_status_history ORDER BY id')).toEqual(
      before.history,
    );
    expect(await linkRows()).toEqual([
      { status: 'ACTIVE', source: 'CLAIM_CODE', evidence_type: 'CLAIM_CODE' },
    ]);
    expect(
      await h.db.query(`SELECT action FROM audit_events WHERE action = 'IDENTITY_LINKED'`),
    ).toHaveLength(1);
    // Repeated claim: no second link.
    expect(
      data<{ alreadyClaimed: boolean }>(await claim(account, g.claimCode ?? '')).alreadyClaimed,
    ).toBe(true);
    expect(await linkRows()).toHaveLength(1);
  });

  it('invalid claims and phone equality alone never create a link', async () => {
    const g = await guestBook(h, a);
    const stranger = await patient(h);
    expect(code(await claim(stranger, 'B'.repeat(43)))).toBe('CLAIM_INVALID');
    const samePhone = await patient(h, g.phone);
    expect(await linkRows()).toEqual([]);
    expect(await identityOf(await personOfBooking(g.id))).not.toBe(
      await identityOf(await selfPerson(samePhone)),
    );
    // Unlinked: the same-phone account may book the same time elsewhere (the system cannot know).
    expect((await book(h, samePhone, slotBody(b, await slotAt(b, '09:00')))).status).toBe(201);
  });
});

describe('conflicts on the canonical identity', () => {
  it('linked identities cannot overlap across clinics (pending holds count); non-overlapping is fine; availability agrees', async () => {
    const g = await guestBook(h, a); // pending hold, clinic A 09:00
    const account = await patient(h);
    await claim(account, g.claimCode ?? '');
    expect(code(await book(h, account, slotBody(b, await slotAt(b, '09:00'))))).toBe(
      'PATIENT_CONFLICT',
    );
    expect((await book(h, account, slotBody(b, await slotAt(b, '10:00')))).status).toBe(201);
    // Booking FOR the claimed guest person is checked against the account's own bookings too.
    const owned = data<{ personId: string; claimed: boolean }[]>(
      await as(h, account).get('/me/booking-persons'),
    ).find((p) => p.claimed)?.personId;
    expect(
      code(await book(h, account, slotBody(a, await slotAt(a, '10:00'), { personId: owned }))),
    ).toBe('PATIENT_CONFLICT');
    const mine = (await slots(h, b, { as: account })).slots.map((s) => s.local.start);
    expect(mine).not.toContain('09:00');
    expect(mine).not.toContain('10:00');
  });

  it('a link between identities with overlapping bookings records an auditable conflict, cancels nothing, and confirmation enforces it', async () => {
    const g = await guestBook(h, a); // A 09:00
    const account = await patient(h);
    const own = await bookSlot(h, b, account, '09:00'); // B 09:00, separate identity → allowed
    const res = await claim(account, g.claimCode ?? '');
    expect(data<{ identityConflicts: number }>(res).identityConflicts).toBe(1);
    expect(await h.db.query('SELECT id FROM identity_link_conflicts')).toHaveLength(1);
    expect(
      await h.db.query(`SELECT action FROM audit_events WHERE action = 'IDENTITY_LINK_CONFLICT'`),
    ).toHaveLength(1);
    expect([await statusOf(h, g.id), await statusOf(h, own)]).toEqual([
      'PENDING_CONFIRMATION',
      'PENDING_CONFIRMATION',
    ]);
    const conflicts = data<{ status: string }[]>(
      await as(h, admin).get('/admin/identity-link-conflicts'),
    );
    expect(conflicts.map((c) => c.status)).toEqual(['OPEN']);
    expect(code(await confirm(h, a, g.id))).toBe('PATIENT_CONFLICT');
    expect(code(await confirm(h, b, own))).toBe('PATIENT_CONFLICT');
    expect((await as(h, account).post(`/me/bookings/${own}/cancel`, {})).status).toBe(200);
    expect((await confirm(h, a, g.id)).status).toBe(200);
    expect(data<unknown[]>(await as(h, admin).get('/admin/identity-link-conflicts'))).toEqual([]);
    // Task 05.2.1: the overlap is gone but nobody recorded a resolution yet → CLEARED, then RESOLVED.
    const all = data<{ conflictId: string; status: string }[]>(
      await as(h, admin).get('/admin/identity-link-conflicts?status=ALL'),
    );
    expect(all.map((c) => c.status)).toEqual(['CLEARED']);
    expect(
      data<{ method: string }>(
        await as(h, admin).post(`/admin/identity-link-conflicts/${all[0]?.conflictId}/resolve`, {
          note: 'Patient kept the clinic A appointment',
        }),
      ).method,
    ).toBe('BOOKING_RELEASED');
    expect(
      data<{ status: string }[]>(
        await as(h, admin).get('/admin/identity-link-conflicts?status=ALL'),
      )[0]?.status,
    ).toBe('RESOLVED');
  });

  it('rescheduling checks the canonical identity', async () => {
    const g = await guestBook(h, a, { start: '11:00' });
    const account = await patient(h);
    await claim(account, g.claimCode ?? '');
    const own = await bookSlot(h, b, account, '09:00');
    await confirm(h, b, own);
    const move = (startsAt: string) =>
      as(h, account)
        .post(`/me/bookings/${own}/reschedule`, { startsAt })
        .set('Idempotency-Key', key());
    expect(code(await move((await slotAt(b, '11:00')).startsAt))).toBe('PATIENT_CONFLICT');
    expect((await move((await slotAt(b, '12:00')).startsAt)).status).toBe(201);
  });

  it('staff-recorded patients: support IDENTITY_LINK with evidence joins the conflict identity without granting access', async () => {
    const receptionist = (await addStaff(h, a.c.owner, a.c.clinicId, 'RECEPTIONIST')).session;
    const s9 = await slotAt(a, '09:00');
    const staffRes = await as(h, receptionist, { clinicId: a.c.clinicId })
      .post('/clinic/bookings', {
        branchId: a.c.branchId,
        serviceId: a.serviceId,
        assignmentId: s9.assignmentId,
        startsAt: s9.startsAt,
        patient: { new: { displayName: 'Walk-in Same Person' } },
      })
      .set('Idempotency-Key', key());
    const staffBooking = data<{ id: string }>(staffRes).id;
    const account = await patient(h);
    expect((await book(h, account, slotBody(b, await slotAt(b, '09:00')))).status).toBe(201); // not linked yet
    await as(h, account).post(
      `/me/bookings/${data<{ id: string }[]>(await as(h, account).get('/me/bookings'))[0]?.id}/cancel`,
      {},
    );
    const caseId = data<{ caseId: string }>(
      await as(h, account).post('/me/identity-cases', {
        kind: 'IDENTITY_LINK',
        statement: 'The clinic booked me by phone as a walk-in; that is me.',
        bookingReference: staffBooking,
      }),
    ).caseId;
    const candidate = data<{ caseId: string; candidatePersonIds: string[] }[]>(
      await as(h, admin).get('/admin/identity-cases?status=OPEN'),
    ).find((c) => c.caseId === caseId)?.candidatePersonIds[0];
    expect(
      code(
        await as(h, admin).post(`/admin/identity-cases/${caseId}/resolve`, {
          decision: 'LINK',
          personId: candidate,
          reason: 'Confirmed',
          verificationNote: 'Clinic confirmed by phone',
        }),
      ),
    ).toBe('VALIDATION_ERROR'); // evidence type is mandatory
    const ok = await as(h, admin).post(`/admin/identity-cases/${caseId}/resolve`, {
      decision: 'LINK',
      personId: candidate,
      reason: 'Confirmed',
      verificationNote: 'Clinic receptionist attested identity at the visit',
      evidenceType: 'CLINIC_ATTESTATION',
    });
    expect(data<{ status: string }>(ok).status).toBe('LINKED');
    expect(
      await h.db.query(
        'SELECT evidence_type, (link_id IS NOT NULL) + 0 AS linked FROM identity_support_cases WHERE id = ?',
        [caseId],
      ),
    ).toEqual([{ evidence_type: 'CLINIC_ATTESTATION', linked: '1' }]);
    expect(code(await book(h, account, slotBody(b, await slotAt(b, '09:00'))))).toBe(
      'PATIENT_CONFLICT',
    ); // now one identity
    expect((await as(h, account).get(`/me/bookings/${staffBooking}`)).status).toBe(404); // association ≠ access
    expect(
      await h.db.query('SELECT claimed_by_user_id FROM booking_persons WHERE id = ?', [
        candidate ?? '',
      ]),
    ).toEqual([{ claimed_by_user_id: null }]);
  });
});

describe('support resolution safety and correction', () => {
  it('non-admins and self-approval are refused; REJECT changes nothing', async () => {
    const g = await guestBook(h, a);
    await h.db.execute('DELETE FROM guest_claim_codes');
    const account = await patient(h, g.phone);
    const caseId = data<{ caseId: string }>(
      await as(h, account).post('/me/identity-cases', {
        statement: 'Guest booking from before claim codes.',
      }),
    ).caseId;
    expect(
      code(
        await as(h, account).post(`/admin/identity-cases/${caseId}/resolve`, {
          decision: 'REJECT',
          reason: 'mine',
          verificationNote: 'self service attempt',
        }),
      ),
    ).toBe('FORBIDDEN');
    const adminCase = data<{ caseId: string }>(
      await as(h, admin).post('/me/identity-cases', {
        statement: 'An admin requesting for themself.',
      }),
    ).caseId;
    expect(
      code(
        await as(h, admin).post(`/admin/identity-cases/${adminCase}/resolve`, {
          decision: 'REJECT',
          reason: 'self',
          verificationNote: 'self approval attempt',
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
    const before = await h.db.query(
      'SELECT id, identity_id, claimed_by_user_id FROM booking_persons ORDER BY id',
    );
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/identity-cases/${caseId}/resolve`, {
          decision: 'REJECT',
          reason: 'No evidence',
          verificationNote: 'Caller could not confirm booking details',
        }),
      ).status,
    ).toBe('REJECTED');
    expect(
      await h.db.query(
        'SELECT id, identity_id, claimed_by_user_id FROM booking_persons ORDER BY id',
      ),
    ).toEqual(before);
    expect(await linkRows()).toEqual([]);
  });

  it('correcting an erroneous link restores the separate identity and keeps all history', async () => {
    const g = await guestBook(h, a);
    const account = await patient(h);
    await claim(account, g.claimCode ?? '');
    const guestPerson = await personOfBooking(g.id);
    const linkId = data<{ id: string }[]>(
      await as(h, admin).get(`/admin/booking-persons/${guestPerson}/identity-links`),
    )[0]?.id;
    expect(
      (
        await as(h, admin).post(`/admin/identity-links/${linkId}/revoke`, {
          reason: 'Linked in error by support',
        })
      ).status,
    ).toBe(200);
    expect(await identityOf(guestPerson)).not.toBe(await identityOf(await selfPerson(account)));
    expect(await linkRows()).toEqual([
      { status: 'REVOKED', source: 'CLAIM_CODE', evidence_type: 'CLAIM_CODE' },
    ]);
    expect(await statusOf(h, g.id)).toBe('PENDING_CONFIRMATION');
    expect(
      await h.db.query('SELECT claimed_by_user_id FROM booking_persons WHERE id = ?', [
        guestPerson,
      ]),
    ).toEqual([{ claimed_by_user_id: account.userId }]); // ownership is separate
    expect((await book(h, account, slotBody(b, await slotAt(b, '09:00')))).status).toBe(201); // separate identities again
    expect(
      code(
        await as(h, admin).post(`/admin/identity-links/${linkId}/revoke`, {
          reason: 'again please',
        }),
      ),
    ).toBe('CONFLICT');
    expect(
      await h.db.query(`SELECT action FROM audit_events WHERE action = 'IDENTITY_LINK_REVOKED'`),
    ).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('six concurrent bookings for two linked person records at the same time in three clinics: exactly one wins', async () => {
    const c = await bookableClinic(h, admin);
    const g = await guestBook(h, a, { start: '12:00' });
    const account = await patient(h);
    await claim(account, g.claimCode ?? '');
    const owned = data<{ personId: string; claimed: boolean }[]>(
      await as(h, account).get('/me/booking-persons'),
    ).find((p) => p.claimed)?.personId;
    const reqs = [];
    for (const clinic of [a, b, c]) {
      const s = await slotAt(clinic, '10:00');
      reqs.push(
        book(h, account, slotBody(clinic, s)),
        book(h, account, slotBody(clinic, s, { personId: owned })),
      );
    }
    const res = await Promise.all(reqs);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => code(r) === 'PATIENT_CONFLICT')).toHaveLength(5);
  });

  it('linking racing a booking never leaves an unrecorded overlap (8 rounds, claim start staggered 0–140 ms)', async () => {
    for (let round = 0; round < 8; round++) {
      await h.reset();
      admin = await adminSession(h);
      a = await bookableClinic(h, admin);
      b = await bookableClinic(h, admin);
      const g = await guestBook(h, a); // A 09:00 pending
      const account = await patient(h);
      await as(h, account).get('/me/booking-persons');
      const body = slotBody(b, await slotAt(b, '09:00')); // computed BEFORE the race starts
      const doClaim = () => claim(account, g.claimCode ?? '');
      const doBook = () => book(h, account, body);
      // The booking path does more work before the identity lock than a claim, so a simultaneous start
      // always lets the claim win; staggering the claim moves it into the booking transaction's window.
      // The stagger only sweeps interleavings; every assertion below holds for ANY interleaving
      // (the deterministic booked-first path is the 'records an auditable conflict' test).
      const pending = doBook().then((r) => r);
      await new Promise((r) => setTimeout(r, round * 20));
      const [claimed, booked] = await Promise.all([doClaim(), pending]);
      expect(claimed.status).toBe(200);
      const conflicts = (await h.db.query('SELECT id FROM identity_link_conflicts')).length;
      if (booked.status === 201)
        expect(conflicts).toBe(1); // booked first → link recorded the overlap
      else {
        expect(code(booked)).toBe('PATIENT_CONFLICT'); // linked first → booking refused
        expect(conflicts).toBe(0);
      }
      // Invariant: every overlapping holding pair inside one identity has a conflict record.
      const unrecorded = await h.db.query(
        `SELECT x.id FROM bookings x JOIN booking_persons px ON px.id = x.person_id
           JOIN bookings y ON y.id > x.id JOIN booking_persons py ON py.id = y.person_id AND py.identity_id = px.identity_id
          WHERE x.active_key = 1 AND y.active_key = 1 AND x.starts_at < y.ends_at AND y.starts_at < x.ends_at
            AND NOT EXISTS (SELECT 1 FROM identity_link_conflicts c WHERE c.booking_a_id = x.id AND c.booking_b_id = y.id)`,
      );
      expect(unrecorded).toEqual([]);
    }
  });

  it('concurrent claims of one guest create exactly one ownership and one link', async () => {
    const g = await guestBook(h, a);
    const accounts = await Promise.all([1, 2, 3, 4].map(() => patient(h)));
    await Promise.all(accounts.map((x) => as(h, x).get('/me/booking-persons')));
    const res = await Promise.all(accounts.map((x) => claim(x, g.claimCode ?? '')));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await linkRows()).toHaveLength(1);
  });
});
