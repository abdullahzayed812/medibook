import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { grantGlobalRole, login, testDevice, type LoggedIn } from '../support/fixtures.js';
import { enrollMfa } from '../support/mfa.js';
import { addStaff, adminSession, as, code, data } from '../support/platform.js';
import {
  book,
  bookableClinic,
  bookSlot,
  guestBook,
  key,
  patient,
  slotBody,
  slots,
  statusOf,
  type BookableClinic,
  type Slot,
} from '../support/bookings.js';

/** Task 05.2.1: identity-link lifecycle — self-approval, revocation, supersede, conflict resolution. */
const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let a: BookableClinic;
let b: BookableClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  a = await bookableClinic(h, admin);
  b = await bookableClinic(h, admin);
});

/**
 * Global consistency of canonical identities, checked after EVERY test (including the races):
 * - at most one ACTIVE link per person;
 * - a person with an ACTIVE link is in that link's target identity, otherwise in its origin;
 * - SELF persons never leave their origin;
 * - a linked person sits in an identity anchored by an account SELF person, and a claimed
 *   person is only ever linked into its owner's identity;
 * - SUPERSEDED links point to a newer link of the same person.
 */
afterEach(async () => {
  const persons = await h.db.query<{
    id: string;
    kind: string;
    identity_id: string;
    origin_identity_id: string;
    claimed_by_user_id: string | null;
  }>('SELECT id, kind, identity_id, origin_identity_id, claimed_by_user_id FROM booking_persons');
  const links = await h.db.query<{
    id: string;
    person_id: string;
    to_identity_id: string;
    status: string;
    superseded_by_link_id: string | null;
  }>(
    'SELECT id, person_id, to_identity_id, status, superseded_by_link_id FROM booking_identity_links',
  );
  for (const p of persons) {
    const active = links.filter((l) => l.person_id === p.id && l.status === 'ACTIVE');
    expect(active.length, `person ${p.id} active links`).toBeLessThanOrEqual(1);
    expect(p.identity_id, `person ${p.id} identity`).toBe(
      active[0]?.to_identity_id ?? p.origin_identity_id,
    );
    if (p.kind === 'SELF') expect(p.identity_id).toBe(p.origin_identity_id);
    if (p.identity_id !== p.origin_identity_id) {
      const anchor = persons.find(
        (x) => x.kind === 'SELF' && x.origin_identity_id === p.identity_id,
      );
      expect(anchor, `person ${p.id} anchored by an account`).toBeDefined();
    }
  }
  const users = await h.db.query<{ id: string; user_id: string | null }>(
    'SELECT origin_identity_id AS id, user_id FROM booking_persons WHERE kind = ?',
    ['SELF'],
  );
  for (const p of persons.filter(
    (x) => x.claimed_by_user_id !== null && x.identity_id !== x.origin_identity_id,
  ))
    expect(users.find((u) => u.id === p.identity_id)?.user_id).toBe(p.claimed_by_user_id);
  for (const l of links.filter((x) => x.status === 'SUPERSEDED')) {
    const newer = links.find((x) => x.id === l.superseded_by_link_id);
    expect(newer?.person_id).toBe(l.person_id);
    expect(Number(newer?.id)).toBeGreaterThan(Number(l.id));
  }
});

// ---------- helpers ----------

const slotAt = async (c: BookableClinic, start: string): Promise<Slot> => {
  const s = (await slots(h, c)).slots.find((x) => x.local.start === start);
  if (s === undefined) throw new Error(`no slot ${start}`);
  return s;
};
const claim = (s: LoggedIn, claimCode: string | null) =>
  as(h, s).post('/me/guest-bookings/claim', { claimCode: claimCode ?? '' });
const one = async <T extends object = Record<string, unknown>>(
  sql: string,
  params: string[] = [],
) => {
  const row = (await h.db.query<T>(sql, params))[0];
  if (row === undefined) throw new Error(`no row for: ${sql}`);
  return row;
};
const identityOf = async (personId: string) =>
  (
    await one<{ identity_id: string }>('SELECT identity_id FROM booking_persons WHERE id = ?', [
      personId,
    ])
  ).identity_id;
const originOf = async (personId: string) =>
  (
    await one<{ o: string }>('SELECT origin_identity_id AS o FROM booking_persons WHERE id = ?', [
      personId,
    ])
  ).o;
const personOfBooking = async (id: string) =>
  (await one<{ person_id: string }>('SELECT person_id FROM bookings WHERE id = ?', [id])).person_id;
const selfPerson = async (s: LoggedIn) =>
  data<{ personId: string; self: boolean }[]>(await as(h, s).get('/me/booking-persons')).find(
    (p) => p.self,
  )?.personId ?? '';
const linkOf = async (personId: string) =>
  data<{ id: string; status: string }[]>(
    await as(h, admin).get(`/admin/booking-persons/${personId}/identity-links`),
  );
const linkRow = (id: string) =>
  one<{ status: string; superseded_by_link_id: string | null; revoked_by_user_id: string | null }>(
    'SELECT status, superseded_by_link_id, revoked_by_user_id FROM booking_identity_links WHERE id = ?',
    [id],
  );
const revoke = (s: LoggedIn, linkId: string, extra: object = {}) =>
  as(h, s).post(`/admin/identity-links/${linkId}/revoke`, { reason: 'Linked in error', ...extra });
const resolveConflict = (s: LoggedIn, conflictId: string, note = 'Patient kept one appointment') =>
  as(h, s).post(`/admin/identity-link-conflicts/${conflictId}/resolve`, { note });
const count = async (sql: string, params: string[] = []) =>
  Number((await one<{ n: string }>(sql, params)).n);
const refusals = (userId: string, codeName: string) =>
  count(
    `SELECT COUNT(*) AS n FROM security_events WHERE event_type = 'IDENTITY_OPERATION_REFUSED' AND user_id = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.code')) = ?`,
    [userId, codeName],
  );

/** A patient account that is ALSO a Super Admin (separate ADMIN_WEB session with MFA). */
async function patientAdmin(): Promise<{ patient: LoggedIn; admin: LoggedIn }> {
  const first = await patient(h);
  await grantGlobalRole(h.db, first.userId, 'SUPER_ADMIN'); // a role grant ends existing sessions
  const s = await login(h, first.phone, { device: testDevice('ADMIN_WEB') });
  await enrollMfa(h, s);
  return { patient: await patient(h, first.phone), admin: s };
}

/** A walk-in recorded by a receptionist of `c` (a CLINIC person; no proof of identity). */
async function staffPatient(c: BookableClinic, start = '09:00') {
  const receptionist = (await addStaff(h, c.c.owner, c.c.clinicId, 'RECEPTIONIST')).session;
  const s = await slotAt(c, start);
  const res = await as(h, receptionist, { clinicId: c.c.clinicId })
    .post('/clinic/bookings', {
      branchId: c.c.branchId,
      serviceId: c.serviceId,
      assignmentId: s.assignmentId,
      startsAt: s.startsAt,
      patient: { new: { displayName: 'Walk-in Patient' } },
    })
    .set('Idempotency-Key', key());
  expect(res.status).toBe(201);
  const id = data<{ id: string }>(res).id;
  return { bookingId: id, personId: await personOfBooking(id) };
}

/** A support IDENTITY_LINK case by `requester` naming `bookingId`, resolved LINK by `resolver`. */
async function supportLink(requester: LoggedIn, bookingId: string, resolver: LoggedIn = admin) {
  const caseId = data<{ caseId: string }>(
    await as(h, requester).post('/me/identity-cases', {
      kind: 'IDENTITY_LINK',
      statement: 'The clinic recorded me as a walk-in; that booking is mine.',
      bookingReference: bookingId,
    }),
  ).caseId;
  const candidate =
    data<{ caseId: string; candidatePersonIds: string[] }[]>(
      await as(h, admin).get('/admin/identity-cases?status=OPEN'),
    ).find((c) => c.caseId === caseId)?.candidatePersonIds[0] ?? '';
  const res = await as(h, resolver).post(`/admin/identity-cases/${caseId}/resolve`, {
    decision: 'LINK',
    personId: candidate,
    reason: 'Confirmed with the clinic',
    verificationNote: 'Receptionist attested the identity at the visit',
    evidenceType: 'CLINIC_ATTESTATION',
  });
  return { caseId, res, linkId: res.status === 200 ? data<{ linkId: string }>(res).linkId : '' };
}

/** Guest booking at clinic A 09:00 claimed by `account`, which also booked clinic B 09:00 → conflict. */
async function conflictSetup(account: LoggedIn) {
  const g = await guestBook(h, a);
  const own = await bookSlot(h, b, account, '09:00');
  expect(
    data<{ identityConflicts: number }>(await claim(account, g.claimCode)).identityConflicts,
  ).toBe(1);
  const conflictId = (await one<{ id: string }>('SELECT id FROM identity_link_conflicts')).id;
  return { guestBooking: g.id, own, conflictId, guestPerson: await personOfBooking(g.id) };
}

const snapshot = async () => ({
  bookings: await h.db.query('SELECT * FROM bookings ORDER BY id'),
  history: await h.db.query('SELECT * FROM booking_status_history ORDER BY id'),
  profiles: await h.db.query('SELECT * FROM patient_profiles ORDER BY id'),
  audit: await h.db.query(
    'SELECT id, action, actor_user_id, target_id, metadata, created_at FROM audit_events ORDER BY id',
  ),
});

// ---------- 1. self-approval on revocation ----------

describe('self-approval protection on link revocation', () => {
  it('a Super Admin cannot revoke a link of their own identity (recorded); another Super Admin can', async () => {
    const pa = await patientAdmin();
    const g = await guestBook(h, a);
    expect((await claim(pa.patient, g.claimCode)).status).toBe(200);
    const guestPerson = await personOfBooking(g.id);
    const linkId = (await linkOf(guestPerson))[0]?.id ?? '';
    const before = await identityOf(guestPerson);

    const refused = await revoke(pa.admin, linkId);
    expect([refused.status, code(refused)]).toEqual([403, 'SELF_APPROVAL_FORBIDDEN']);
    expect(await identityOf(guestPerson)).toBe(before);
    expect((await linkRow(linkId)).status).toBe('ACTIVE');
    expect(
      await count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'IDENTITY_LINK_REVOKED'`),
    ).toBe(0);
    expect(await refusals(pa.patient.userId, 'SELF_APPROVAL_FORBIDDEN')).toBe(1);

    expect((await revoke(admin, linkId)).status).toBe(200);
    expect(await identityOf(guestPerson)).toBe(await originOf(guestPerson));
    expect((await linkRow(linkId)).revoked_by_user_id).toBe(admin.userId);
  });

  it('a Super Admin who owns the linked person itself (claim) is involved too; non-admins are refused', async () => {
    const pa = await patientAdmin();
    const s = await staffPatient(a);
    const { linkId } = await supportLink(pa.patient, s.bookingId); // CLINIC person → admin's identity
    expect(code(await revoke(pa.admin, linkId))).toBe('SELF_APPROVAL_FORBIDDEN');
    const p = await patient(h);
    expect(code(await revoke(p, linkId))).toBe('FORBIDDEN');
    expect((await linkRow(linkId)).status).toBe('ACTIVE');
  });
});

// ---------- 2. revocation with releaseOwnership ----------

describe('revocation with releaseOwnership: true', () => {
  it('restores the origin identity, releases ownership, keeps every record and the link history', async () => {
    const g = await guestBook(h, a); // A 09:00, pending
    const account = await patient(h);
    await claim(account, g.claimCode);
    await bookSlot(h, b, account, '10:00');
    const guestPerson = await personOfBooking(g.id);
    const linkId = (await linkOf(guestPerson))[0]?.id ?? '';
    const before = await snapshot();

    const res = await revoke(admin, linkId, { releaseOwnership: true });
    expect(data<{ ownershipReleased: boolean }>(res)).toMatchObject({
      status: 'REVOKED',
      ownershipReleased: true,
    });

    expect(await identityOf(guestPerson)).toBe(await originOf(guestPerson));
    expect(await identityOf(await selfPerson(account))).toBe(
      await originOf(await selfPerson(account)),
    );
    expect(
      await one('SELECT claimed_by_user_id, claimed_at FROM booking_persons WHERE id = ?', [
        guestPerson,
      ]),
    ).toEqual({
      claimed_by_user_id: null,
      claimed_at: null,
    });
    const after = await snapshot();
    expect(after.bookings).toEqual(before.bookings); // nothing deleted, transferred or re-statused
    expect(after.history).toEqual(before.history);
    expect(after.profiles).toEqual(before.profiles);
    expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit); // history only appended
    expect(
      after.audit.slice(before.audit.length).map((e) => (e as { action: string }).action),
    ).toEqual(['IDENTITY_LINK_REVOKED']);
    const history = await linkOf(guestPerson);
    expect(history.map((l) => l.status)).toEqual(['REVOKED']);
    // Ownership released: the account no longer sees or books for the guest person.
    expect((await as(h, account).get(`/me/bookings/${g.id}`)).status).toBe(404);
    expect(
      data<{ personId: string }[]>(await as(h, account).get('/me/booking-persons')).map(
        (p) => p.personId,
      ),
    ).not.toContain(guestPerson);
    // Conflicts follow the resulting identities: separate again, so the overlap is allowed.
    expect((await book(h, account, slotBody(b, await slotAt(b, '09:00')))).status).toBe(201);
    // …and inside each identity the rule still holds.
    expect(code(await book(h, account, slotBody(a, await slotAt(a, '10:00'))))).toBe(
      'PATIENT_CONFLICT',
    );
  });

  it('is atomic: a failure after the identity and ownership updates leaves everything as before', async () => {
    const g = await guestBook(h, a);
    const account = await patient(h);
    await claim(account, g.claimCode);
    const guestPerson = await personOfBooking(g.id);
    const linkId = (await linkOf(guestPerson))[0]?.id ?? '';
    const before = await one(
      'SELECT identity_id, claimed_by_user_id FROM booking_persons WHERE id = ?',
      [guestPerson],
    );
    // The audit INSERT is the LAST statement of the revocation transaction: make it fail.
    await h.db.execute(
      `ALTER TABLE audit_events ADD CONSTRAINT ck_t0521_reject CHECK (action <> 'IDENTITY_LINK_REVOKED')`,
    );
    try {
      expect((await revoke(admin, linkId, { releaseOwnership: true })).status).toBe(500);
      expect(
        await one('SELECT identity_id, claimed_by_user_id FROM booking_persons WHERE id = ?', [
          guestPerson,
        ]),
      ).toEqual(before);
      expect((await linkRow(linkId)).status).toBe('ACTIVE');
    } finally {
      await h.db.execute('ALTER TABLE audit_events DROP CHECK ck_t0521_reject');
    }
    expect((await revoke(admin, linkId, { releaseOwnership: true })).status).toBe(200);
  });
});

// ---------- 3. superseded links ----------

describe('superseded links', () => {
  it('a newer verified link supersedes the old one, moves only that person, and the old link cannot be revoked', async () => {
    const walkIn = await staffPatient(a); // CLINIC person, clinic A 09:00
    const first = await patient(h);
    const second = await patient(h);
    const firstSelf = await selfPerson(first);
    const l1 = (await supportLink(first, walkIn.bookingId)).linkId;
    expect(await identityOf(walkIn.personId)).toBe(await identityOf(firstSelf));

    // Support later establishes, with evidence, that the walk-in is actually `second`.
    const l2 = (await supportLink(second, walkIn.bookingId)).linkId;
    expect(await identityOf(walkIn.personId)).toBe(await identityOf(await selfPerson(second)));
    expect(await identityOf(firstSelf)).toBe(await originOf(firstSelf)); // `first` itself never moves
    expect(await linkRow(l1)).toMatchObject({ status: 'SUPERSEDED', superseded_by_link_id: l2 });
    expect(
      await count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'IDENTITY_LINKED'`),
    ).toBe(2);

    const stale = await revoke(admin, l1);
    expect([stale.status, code(stale)]).toEqual([409, 'IDENTITY_LINK_SUPERSEDED']);
    expect(await identityOf(walkIn.personId)).toBe(await identityOf(await selfPerson(second)));
    expect((await linkRow(l2)).status).toBe('ACTIVE');
    expect((await linkRow(l1)).status).toBe('SUPERSEDED');
    expect(await refusals(admin.userId, 'IDENTITY_LINK_SUPERSEDED')).toBe(1);

    // Conflicts follow the current link: `second` is busy at 09:00, `first` is not.
    expect(code(await book(h, second, slotBody(b, await slotAt(b, '09:00'))))).toBe(
      'PATIENT_CONFLICT',
    );
    expect((await book(h, first, slotBody(b, await slotAt(b, '09:00')))).status).toBe(201);

    // Revoking the CURRENT link returns the walk-in to its own origin (never to `first`).
    expect((await revoke(admin, l2)).status).toBe(200);
    expect(await identityOf(walkIn.personId)).toBe(await originOf(walkIn.personId));
    expect((await linkOf(walkIn.personId)).map((l) => l.status)).toEqual(['SUPERSEDED', 'REVOKED']);
  });

  it('a person owned by one account is never identity-linked to another account', async () => {
    const g = await guestBook(h, a);
    const owner = await patient(h);
    await claim(owner, g.claimCode);
    const other = await patient(h);
    const before = await one(
      'SELECT identity_id, claimed_by_user_id FROM booking_persons WHERE id = ?',
      [await personOfBooking(g.id)],
    );
    const { res, caseId } = await supportLink(other, g.id);
    expect([res.status, code(res)]).toEqual([409, 'IDENTITY_OWNED_ELSEWHERE']);
    expect(
      await one('SELECT identity_id, claimed_by_user_id FROM booking_persons WHERE id = ?', [
        await personOfBooking(g.id),
      ]),
    ).toEqual(before);
    expect(await one('SELECT status FROM identity_support_cases WHERE id = ?', [caseId])).toEqual({
      status: 'OPEN',
    });
  });
});

// ---------- 4. conflict resolution endpoint ----------

describe('identity-link conflict resolution', () => {
  it('unauthorized users and the involved Super Admin are refused', async () => {
    const pa = await patientAdmin();
    const { conflictId } = await conflictSetup(pa.patient);
    expect(code(await resolveConflict(await patient(h), conflictId))).toBe('FORBIDDEN');
    expect(code(await resolveConflict(a.c.owner, conflictId))).toBe('FORBIDDEN');
    const self = await resolveConflict(pa.admin, conflictId);
    expect([self.status, code(self)]).toEqual([403, 'SELF_APPROVAL_FORBIDDEN']);
    expect(await refusals(pa.patient.userId, 'SELF_APPROVAL_FORBIDDEN')).toBe(1);
    expect(
      await one('SELECT resolved_at FROM identity_link_conflicts WHERE id = ?', [conflictId]),
    ).toEqual({ resolved_at: null });
  });

  it('cannot be resolved while the overlap remains; resolving never touches a booking', async () => {
    const account = await patient(h);
    const { conflictId, guestBooking, own } = await conflictSetup(account);
    const before = await snapshot();
    const res = await resolveConflict(admin, conflictId);
    expect([res.status, code(res)]).toEqual([409, 'IDENTITY_CONFLICT_STILL_OVERLAPPING']);
    const after = await snapshot();
    expect(after.bookings).toEqual(before.bookings);
    expect(after.history).toEqual(before.history);
    expect([await statusOf(h, guestBooking), await statusOf(h, own)]).toEqual([
      'PENDING_CONFIRMATION',
      'PENDING_CONFIRMATION',
    ]);
    expect(await refusals(admin.userId, 'IDENTITY_CONFLICT_STILL_OVERLAPPING')).toBe(1);
  });

  it('records actor, note, time and method; repeats are safe; a resolution is final', async () => {
    const account = await patient(h);
    const { conflictId, guestBooking, own } = await conflictSetup(account);
    expect((await as(h, account).post(`/me/bookings/${own}/cancel`, {})).status).toBe(200);
    const before = await snapshot();
    const t0 = h.clock().getTime();
    const res = await resolveConflict(admin, conflictId, 'Patient kept the clinic A appointment');
    const t1 = h.clock().getTime();
    expect(data(res)).toMatchObject({
      status: 'RESOLVED',
      method: 'BOOKING_RELEASED',
      resolvedByUserId: admin.userId,
      alreadyResolved: false,
    });
    const row = await one(
      'SELECT resolved_at, resolved_by_user_id, resolution_note, resolution_method FROM identity_link_conflicts WHERE id = ?',
      [conflictId],
    );
    expect(row).toMatchObject({
      resolved_by_user_id: admin.userId,
      resolution_note: 'Patient kept the clinic A appointment',
      resolution_method: 'BOOKING_RELEASED',
    });
    const at = (row.resolved_at as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(t0);
    expect(at).toBeLessThanOrEqual(t1);
    const after = await snapshot();
    expect(after.bookings).toEqual(before.bookings); // not cancelled, confirmed, moved or transferred
    expect(after.history).toEqual(before.history);
    expect(await statusOf(h, guestBooking)).toBe('PENDING_CONFIRMATION');
    const resolvedAudits = () =>
      count(
        `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'IDENTITY_LINK_CONFLICT_RESOLVED'`,
      );
    expect(await resolvedAudits()).toBe(1);

    // Identical repeat (a client retry): replays, no new effects.
    const again = await resolveConflict(admin, conflictId, 'Patient kept the clinic A appointment');
    expect(data(again)).toMatchObject({
      status: 'RESOLVED',
      alreadyResolved: true,
      method: 'BOOKING_RELEASED',
    });
    expect(await resolvedAudits()).toBe(1);
    // Stale or different requests cannot modify or reopen it.
    expect(code(await resolveConflict(admin, conflictId, 'A different conclusion'))).toBe(
      'IDENTITY_CONFLICT_ALREADY_RESOLVED',
    );
    expect(
      code(
        await resolveConflict(
          await adminSession(h),
          conflictId,
          'Patient kept the clinic A appointment',
        ),
      ),
    ).toBe('IDENTITY_CONFLICT_ALREADY_RESOLVED');
    expect(
      await one(
        'SELECT resolved_by_user_id, resolution_note, resolution_method FROM identity_link_conflicts WHERE id = ?',
        [conflictId],
      ),
    ).toEqual({
      resolved_by_user_id: admin.userId,
      resolution_note: 'Patient kept the clinic A appointment',
      resolution_method: 'BOOKING_RELEASED',
    });
    expect(
      data<{ status: string }[]>(
        await as(h, admin).get('/admin/identity-link-conflicts?status=ALL'),
      )[0]?.status,
    ).toBe('RESOLVED');
  });

  it('after the link is revoked the conflict is CLEARED and resolves as LINK_REVOKED, with both bookings intact', async () => {
    const account = await patient(h);
    const { conflictId, guestBooking, own, guestPerson } = await conflictSetup(account);
    const linkId = (await linkOf(guestPerson))[0]?.id ?? '';
    expect((await revoke(admin, linkId)).status).toBe(200);
    expect(
      data<{ status: string }[]>(
        await as(h, admin).get('/admin/identity-link-conflicts?status=ALL'),
      )[0]?.status,
    ).toBe('CLEARED');
    expect(
      data(await resolveConflict(admin, conflictId, 'Link was wrong; both bookings are valid')),
    ).toMatchObject({ method: 'LINK_REVOKED' });
    expect([await statusOf(h, guestBooking), await statusOf(h, own)]).toEqual([
      'PENDING_CONFIRMATION',
      'PENDING_CONFIRMATION',
    ]);
  });
});

// ---------- 5. concurrency ----------

describe('concurrency', () => {
  it('three concurrent revocations of one link: exactly one succeeds', async () => {
    const g = await guestBook(h, a);
    const account = await patient(h);
    await claim(account, g.claimCode);
    const guestPerson = await personOfBooking(g.id);
    const linkId = (await linkOf(guestPerson))[0]?.id ?? '';
    const admins = [admin, await adminSession(h), await adminSession(h)];
    const res = await Promise.all(admins.map((x) => revoke(x, linkId, { releaseOwnership: true })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(2);
    expect(
      await count(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'IDENTITY_LINK_REVOKED'`),
    ).toBe(1);
  });

  it('revocation racing an overlapping booking (8 rounds, staggered): the booking is refused only while linked', async () => {
    for (let round = 0; round < 8; round++) {
      await h.reset();
      admin = await adminSession(h);
      a = await bookableClinic(h, admin);
      b = await bookableClinic(h, admin);
      const g = await guestBook(h, a); // A 09:00 pending
      const account = await patient(h);
      await claim(account, g.claimCode);
      const linkId = (await linkOf(await personOfBooking(g.id)))[0]?.id ?? '';
      const body = slotBody(b, await slotAt(b, '09:00'));
      // The stagger only sweeps interleavings; every assertion holds for ANY interleaving.
      const pending = book(h, account, body).then((r) => r);
      await new Promise((r) => setTimeout(r, round * 20));
      const [revoked, booked] = await Promise.all([revoke(admin, linkId), pending]);
      expect(revoked.status).toBe(200);
      expect([201, 409]).toContain(booked.status);
      if (booked.status === 409) expect(code(booked)).toBe('PATIENT_CONFLICT');
      // Never an overlap inside one identity without a conflict record.
      expect(
        await h.db.query(
          `SELECT x.id FROM bookings x JOIN booking_persons px ON px.id = x.person_id
             JOIN bookings y ON y.id > x.id JOIN booking_persons py ON py.id = y.person_id AND py.identity_id = px.identity_id
            WHERE x.active_key = 1 AND y.active_key = 1 AND x.starts_at < y.ends_at AND y.starts_at < x.ends_at
              AND NOT EXISTS (SELECT 1 FROM identity_link_conflicts c WHERE c.booking_a_id = x.id AND c.booking_b_id = y.id)`,
        ),
      ).toEqual([]);
    }
  });

  it('a superseding link racing revocation of the old link (8 rounds): never two active links, never a stale revoke', async () => {
    for (let round = 0; round < 8; round++) {
      await h.reset();
      admin = await adminSession(h);
      a = await bookableClinic(h, admin);
      b = await bookableClinic(h, admin);
      const walkIn = await staffPatient(a);
      const first = await patient(h);
      const second = await patient(h);
      const l1 = (await supportLink(first, walkIn.bookingId)).linkId;
      const caseId = data<{ caseId: string }>(
        await as(h, second).post('/me/identity-cases', {
          kind: 'IDENTITY_LINK',
          statement: 'The clinic recorded me as a walk-in; that booking is mine.',
          bookingReference: walkIn.bookingId,
        }),
      ).caseId;
      await selfPerson(second);
      const relink = () =>
        as(h, admin).post(`/admin/identity-cases/${caseId}/resolve`, {
          decision: 'LINK',
          personId: walkIn.personId,
          reason: 'Confirmed with the clinic',
          verificationNote: 'Receptionist attested the identity at the visit',
          evidenceType: 'CLINIC_ATTESTATION',
        });
      const other = await adminSession(h);
      // Alternate which request starts first and sweep the gap (interleavings only; the
      // assertions below hold for ANY order).
      const gap = () => new Promise((r) => setTimeout(r, (round >> 1) * 15));
      let relinked, revoked;
      if (round % 2 === 0) {
        const pending = revoke(other, l1).then((r) => r);
        await gap();
        [relinked, revoked] = await Promise.all([relink(), pending]);
      } else {
        const pending = relink().then((r) => r);
        await gap();
        [revoked, relinked] = await Promise.all([revoke(other, l1), pending]);
      }
      expect(relinked.status).toBe(200); // the newer verified link always lands
      const l1Status = (await linkRow(l1)).status;
      if (revoked.status === 200)
        expect(l1Status).toBe('REVOKED'); // revoke first, then link from origin
      else {
        expect(code(revoked)).toBe('IDENTITY_LINK_SUPERSEDED'); // link first: stale revoke refused
        expect(l1Status).toBe('SUPERSEDED');
      }
      expect(await identityOf(walkIn.personId)).toBe(await identityOf(await selfPerson(second)));
    }
  });

  it('three Super Admins resolving one cleared conflict concurrently: one resolution, no duplicate effects', async () => {
    const account = await patient(h);
    const { conflictId, own } = await conflictSetup(account);
    await as(h, account).post(`/me/bookings/${own}/cancel`, {});
    const admins = [admin, await adminSession(h), await adminSession(h)];
    const res = await Promise.all(
      admins.map((x, i) => resolveConflict(x, conflictId, `Resolution note ${i}`)),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => code(r) === 'IDENTITY_CONFLICT_ALREADY_RESOLVED')).toHaveLength(2);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'IDENTITY_LINK_CONFLICT_RESOLVED'`,
      ),
    ).toBe(1);
  });
});
