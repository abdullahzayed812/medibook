import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { testPhone, type LoggedIn } from '../support/fixtures.js';
import { adminSession, as, code, data } from '../support/platform.js';
import {
  bookableClinic,
  bookSlot,
  changePhone,
  guestBook,
  guestToken,
  patient,
  type BookableClinic,
} from '../support/bookings.js';

/** Task 05.1: ownership needs proof, never just a phone number. */
const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let b: BookableClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  b = await bookableClinic(h, admin);
});

const claim = (s: LoggedIn, claimCode: string) =>
  as(h, s).post('/me/guest-bookings/claim', { claimCode });
const mine = async (s: LoggedIn) =>
  data<{ id: string }[]>(await as(h, s).get('/me/bookings')).map((x) => x.id);
const guestList = async (token: string) =>
  data<{ id: string }[]>(
    await h.http().get('/api/v1/guest/bookings').set('X-Guest-Token', token),
  ).map((x) => x.id);
const attach = (token: string, claimCode: string) =>
  h.http().post('/api/v1/guest/sessions/attach').set('X-Guest-Token', token).send({ claimCode });
const FAKE = 'A'.repeat(43);

describe('guest claim proof', () => {
  it('a valid claim code transfers ownership once; repeats are idempotent; nobody else can reuse it', async () => {
    const g = await guestBook(h, b);
    expect(g.claimCode).not.toBeNull();
    const owner = await patient(h);
    const first = await claim(owner, g.claimCode ?? '');
    expect(data<{ alreadyClaimed: boolean; bookings: number }>(first)).toMatchObject({
      alreadyClaimed: false,
      bookings: 1,
    });
    const again = await claim(owner, g.claimCode ?? '');
    expect(data<{ alreadyClaimed: boolean; personId: string }>(again)).toMatchObject({
      alreadyClaimed: true,
      personId: data<{ personId: string }>(first).personId,
    });
    expect(await mine(owner)).toContain(g.id);
    // Another account using the same (consumed) proof gets the generic error and nothing.
    const thief = await patient(h);
    expect(code(await claim(thief, g.claimCode ?? ''))).toBe('CLAIM_INVALID');
    expect(await mine(thief)).not.toContain(g.id);
    // The claim ended guest access with the old session; the code no longer attaches.
    expect(code(await h.http().get('/api/v1/guest/bookings').set('X-Guest-Token', g.token))).toBe(
      'GUEST_SESSION_INVALID',
    );
    expect(
      await h.db.query(`SELECT action FROM audit_events WHERE action = 'BOOKING_PERSON_CLAIMED'`),
    ).toHaveLength(1);
    // The claim code never appears in stored replays, audit or the outbox.
    const leaks = await h.db.query<{ n: string }>(
      `SELECT (SELECT COUNT(*) FROM idempotency_keys WHERE response_body LIKE ?) + (SELECT COUNT(*) FROM audit_events WHERE metadata LIKE ?)
            + (SELECT COUNT(*) FROM domain_events WHERE payload LIKE ?) AS n`,
      [`%${g.claimCode ?? ''}%`, `%${g.claimCode ?? ''}%`, `%${g.claimCode ?? ''}%`],
    );
    expect(Number(leaks[0]?.n)).toBe(0);
  });

  it('phone verification alone never claims: same phone account, no code / wrong code', async () => {
    const g = await guestBook(h, b);
    const samePhone = await patient(h, g.phone);
    expect(await mine(samePhone)).toEqual([]);
    expect((await as(h, samePhone).post('/me/guest-bookings/claim', {})).status).toBe(400);
    expect(code(await claim(samePhone, FAKE))).toBe('CLAIM_INVALID');
    expect((await as(h, samePhone).get(`/me/bookings/${g.id}`)).status).toBe(404);
    expect(
      data<{ self: boolean }[]>(await as(h, samePhone).get('/me/booking-persons')),
    ).toHaveLength(1);
  });

  it('expired and revoked (rotated) proofs cannot be reused', async () => {
    const g = await guestBook(h, b);
    const rotated = await h.http().post('/api/v1/guest/claim-codes').set('X-Guest-Token', g.token);
    expect(rotated.status).toBe(201);
    expect(rotated.headers['cache-control']).toBe('no-store');
    const fresh = data<{ claimCode: string }>(rotated).claimCode;
    const acct = await patient(h);
    expect(code(await claim(acct, g.claimCode ?? ''))).toBe('CLAIM_INVALID'); // revoked by rotation
    await h.db.execute(
      `UPDATE guest_claim_codes SET expires_at = '2000-01-01' WHERE status = 'ACTIVE'`,
    );
    expect(code(await claim(acct, fresh))).toBe('CLAIM_INVALID'); // expired
    expect(await mine(acct)).toEqual([]);
  });

  it('two accounts racing to claim the same guest identity: exactly one wins', async () => {
    const g = await guestBook(h, b);
    const accounts = await Promise.all([1, 2, 3, 4].map(() => patient(h)));
    const results = await Promise.all(accounts.map((a) => claim(a, g.claimCode ?? '')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => code(r) === 'CLAIM_INVALID')).toHaveLength(3);
    const [row] = await h.db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM booking_persons WHERE claimed_by_user_id IS NOT NULL',
    );
    expect(Number(row?.n)).toBe(1);
  });

  it('a returning guest re-attaches with code + same phone; other phones and brute force are refused', async () => {
    const g = await guestBook(h, b);
    const back = await guestToken(h, g.phone);
    expect(await guestList(back.token)).toEqual([]); // a new session starts empty
    expect((await attach(back.token, g.claimCode ?? '')).status).toBe(200);
    expect(await guestList(back.token)).toEqual([g.id]);
    // Someone else's phone with the right code: refused (two factors).
    const other = await guestToken(h);
    expect(code(await attach(other.token, g.claimCode ?? ''))).toBe('CLAIM_INVALID');
    // Brute force: the session locks after 5 failures, even for the right code.
    const victim = await guestToken(h, g.phone);
    for (let i = 0; i < 5; i++)
      expect(code(await attach(victim.token, FAKE))).toBe('CLAIM_INVALID');
    expect(code(await attach(victim.token, g.claimCode ?? ''))).toBe('GUEST_ATTACH_LOCKED');
  });
});

describe('recycled phones, phone changes and support resolution', () => {
  it("a recycled number's new owner inherits nothing: new guest person, no claim, support case only", async () => {
    const old = await guestBook(h, b); // previous owner of the number
    const newOwner = await guestBook(h, b, { phone: old.phone, start: '10:00' }); // new owner, new session
    expect(newOwner.claimCode).not.toBe(old.claimCode);
    expect(await guestList(newOwner.token)).toEqual([newOwner.id]);
    const persons = await h.db.query<{ person_id: string }>(
      'SELECT person_id FROM bookings ORDER BY id',
    );
    expect(new Set(persons.map((p) => p.person_id)).size).toBe(2); // never merged by phone
    const account = await patient(h, old.phone);
    expect(await mine(account)).toEqual([]);
    const opened = await as(h, account).post('/me/identity-cases', {
      statement: 'I booked as a guest last year with this number.',
    });
    expect(opened.status).toBe(202);
    expect(JSON.stringify(opened.body)).not.toMatch(/candidate|person/i); // requester learns nothing
  });

  it('legacy guest bookings without proof: support-assisted LINK by another Super Admin, audited; REJECT closes', async () => {
    const g = await guestBook(h, b);
    await h.db.execute('DELETE FROM guest_claim_codes'); // simulate a booking made before claim codes existed
    const account = await patient(h, g.phone);
    const caseId = data<{ caseId: string }>(
      await as(h, account).post('/me/identity-cases', {
        statement: 'Booked as a guest before the app had accounts.',
        bookingReference: g.id,
      }),
    ).caseId;
    expect(code(await as(h, account).get('/admin/identity-cases'))).toBe('FORBIDDEN');
    const cases = data<{ caseId: string; candidatePersonIds: string[] }[]>(
      await as(h, admin).get('/admin/identity-cases?status=OPEN'),
    );
    const candidate = cases.find((c) => c.caseId === caseId)?.candidatePersonIds[0];
    expect(candidate).toBeDefined();
    const resolved = await as(h, admin).post(`/admin/identity-cases/${caseId}/resolve`, {
      decision: 'LINK',
      personId: candidate,
      reason: 'Identity confirmed',
      verificationNote: 'Matched booking details and ID document by phone call',
      evidenceType: 'BOOKING_DETAILS', // Task 05.2: evidence type is mandatory for LINK
    });
    expect(data<{ status: string }>(resolved).status).toBe('LINKED');
    expect(await mine(account)).toContain(g.id);
    expect(
      code(
        await as(h, admin).post(`/admin/identity-cases/${caseId}/resolve`, {
          decision: 'REJECT',
          reason: 'again',
          verificationNote: 'second decision',
        }),
      ),
    ).toBe('CONFLICT');
    const audit = await h.db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action IN ('IDENTITY_CASE_OPENED', 'IDENTITY_CASE_RESOLVED', 'BOOKING_PERSON_CLAIMED') ORDER BY id`,
    );
    expect(audit.map((a) => a.action)).toEqual([
      'IDENTITY_CASE_OPENED',
      'BOOKING_PERSON_CLAIMED',
      'IDENTITY_CASE_RESOLVED',
    ]);
    const rejected = data<{ caseId: string }>(
      await as(h, account).post('/me/identity-cases', {
        statement: 'Another booking I believe is mine.',
      }),
    ).caseId;
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/identity-cases/${rejected}/resolve`, {
          decision: 'REJECT',
          reason: 'No evidence',
          verificationNote: 'Caller could not confirm details',
        }),
      ).status,
    ).toBe('REJECTED');
  });

  it('an account changes its verified phone: same identity, nothing moves; the old number starts fresh', async () => {
    const p1 = testPhone();
    const a = await patient(h, p1);
    const booked = await bookSlot(h, b, a, '09:00');
    const personBefore = data<{ personId: string }[]>(await as(h, a).get('/me/booking-persons'))[0]
      ?.personId;
    const p2 = testPhone();
    const res = await changePhone(h, a, p1, p2);
    expect(res.status).toBe(200);
    expect(await mine(a)).toEqual([booked]);
    expect(
      data<{ personId: string }[]>(await as(h, a).get('/me/booking-persons'))[0]?.personId,
    ).toBe(personBefore);
    expect(
      await h.db.query(`SELECT action FROM audit_events WHERE action = 'ACCOUNT_PHONE_CHANGED'`),
    ).toHaveLength(1);
    // Someone else now verifies the OLD number: a new account and person, no history.
    const b2 = await patient(h, p1);
    expect(b2.userId).not.toBe(a.userId);
    expect(await mine(b2)).toEqual([]);
    expect(
      data<{ personId: string }[]>(await as(h, b2).get('/me/booking-persons'))[0]?.personId,
    ).not.toBe(personBefore);
    // Wrong codes and taken numbers are refused.
    await h.clearCooldowns();
    const req = data<{ currentChallengeId: string; newChallengeId: string }>(
      await as(h, a).post('/me/phone/change-requests', { phone: testPhone() }),
    );
    expect(
      code(
        await as(h, a).post('/me/phone/change-requests/verify', {
          phone: p1,
          currentChallengeId: req.currentChallengeId,
          newChallengeId: req.newChallengeId,
          currentCode: '000000',
          newCode: '000000',
        }),
      ),
    ).toBe('OTP_INVALID');
    await h.clearCooldowns();
    expect(code(await as(h, a).post('/me/phone/change-requests', { phone: p1 }))).toBe(
      'PHONE_UNAVAILABLE',
    );
  });
});
