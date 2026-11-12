import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { testPhone, type LoggedIn } from '../support/fixtures.js';
import {
  addStaff,
  adminSession,
  as,
  code,
  data,
  onboardClinic,
  userSession,
  type OnboardedClinic,
} from '../support/platform.js';

/**
 * Task 03.2: re-inviting a member whose (clinic, user, role) row already exists starts a NEW
 * membership period. A stale effective window from an earlier period must never make the new
 * membership ACTIVE but ineffective, and the earlier period stays auditable.
 */
const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let c: OnboardedClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  c = await onboardClinic(h, admin, { paid: true });
});

const owner = () => as(h, c.owner, { clinicId: c.clinicId });
const invite = (phone: string, role = 'DOCTOR') =>
  owner().post('/clinic/invitations', { phone, role, branchScope: 'ALL', branchIds: [] });
const accept = (s: LoggedIn, token: string) => as(h, s).post('/invitations/accept', { token });
const tokenOf = (res: { body: unknown }) => data<{ token: string }>(res).token;
const rowOf = async (membershipId: string) =>
  (
    await h.db.query<{
      status: string;
      effective_from: Date | null;
      effective_until: Date | null;
      activated_at: Date | null;
      terminated_at: Date | null;
    }>(
      'SELECT status, effective_from, effective_until, activated_at, terminated_at FROM clinic_memberships WHERE id = ?',
      [membershipId],
    )
  )[0];
const setWindow = (membershipId: string, from: Date | null, until: Date | null) =>
  h.db.execute(
    'UPDATE clinic_memberships SET effective_from = ?, effective_until = ? WHERE id = ?',
    [from, until, membershipId],
  );
const MINUTE = 60_000;

describe('membership re-invitation', () => {
  it('re-inviting a terminated member whose old end date has passed starts a valid new period; history and other clinics are preserved', async () => {
    const doctor = await addStaff(h, c.owner, c.clinicId, 'DOCTOR');
    const other = await onboardClinic(h, admin, { paid: true });
    const otherMembership = await addStaff(h, other.owner, other.clinicId, 'RECEPTIONIST', {
      member: doctor,
    });
    // Earlier period with a bounded window (e.g. a locum contract), then terminated.
    const oldFrom = new Date(h.clock().getTime() - 30 * 24 * 60 * MINUTE);
    const oldUntil = new Date(h.clock().getTime() + MINUTE);
    await setWindow(doctor.membershipId, oldFrom, oldUntil);
    expect(
      (
        await owner().patch(`/clinic/members/${doctor.membershipId}/status`, {
          status: 'TERMINATED',
          reason: 'Contract ended',
        })
      ).status,
    ).toBe(204);
    const terminated = await rowOf(doctor.membershipId);
    h.clock.advance(2 * MINUTE); // the old end date is now in the past
    const otherBefore = await h.db.query('SELECT * FROM clinic_memberships WHERE id = ?', [
      otherMembership.membershipId,
    ]);
    const accountBefore = await h.db.query('SELECT status, phone_e164 FROM users WHERE id = ?', [
      doctor.session.userId,
    ]);

    const invited = await invite(doctor.phone);
    expect(invited.status).toBe(201);
    const accepted = await accept(doctor.session, tokenOf(invited));
    expect(accepted.status).toBe(200);
    expect(data<{ membershipId: string }>(accepted).membershipId).toBe(doctor.membershipId);

    // New period: open-ended from now, effective immediately.
    const row = await rowOf(doctor.membershipId);
    expect(row).toMatchObject({
      status: 'ACTIVE',
      effective_from: null,
      effective_until: null,
      terminated_at: null,
    });
    expect(row?.activated_at?.getTime()).toBeGreaterThan(oldUntil.getTime());
    expect((await as(h, doctor.session, { clinicId: c.clinicId }).get('/clinic')).status).toBe(200);

    // History: every transition kept, and the full previous period is in the audit log.
    const events = await h.db.query<{ to_status: string; reason: string | null }>(
      'SELECT to_status, reason FROM clinic_membership_events WHERE membership_id = ? ORDER BY id',
      [doctor.membershipId],
    );
    expect(events.map((e) => e.to_status)).toEqual(['ACTIVE', 'TERMINATED', 'ACTIVE']);
    expect(events[2]?.reason).toMatch(/new membership period/);
    const [audit] = await h.db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'MEMBERSHIP_CREATED' AND target_id = ? ORDER BY id DESC LIMIT 1`,
      [doctor.membershipId],
    );
    expect(audit?.metadata).toMatchObject({
      reactivated: true,
      previousPeriod: {
        status: 'TERMINATED',
        effectiveFrom: oldFrom.toISOString(),
        effectiveUntil: oldUntil.toISOString(),
        terminatedAt: terminated?.terminated_at?.toISOString(),
      },
    });

    // Nothing outside this clinic changed.
    expect(
      await h.db.query('SELECT * FROM clinic_memberships WHERE id = ?', [
        otherMembership.membershipId,
      ]),
    ).toEqual(otherBefore);
    expect(
      await h.db.query('SELECT status, phone_e164 FROM users WHERE id = ?', [
        doctor.session.userId,
      ]),
    ).toEqual(accountBefore);
  });

  it('an ACTIVE membership whose window has ended can be renewed by a new invitation', async () => {
    const doctor = await addStaff(h, c.owner, c.clinicId, 'DOCTOR');
    await setWindow(doctor.membershipId, null, new Date(h.clock().getTime() + MINUTE));
    h.clock.advance(2 * MINUTE);
    expect(code(await as(h, doctor.session, { clinicId: c.clinicId }).get('/clinic'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    const invited = await invite(doctor.phone);
    expect(invited.status).toBe(201);
    expect((await accept(doctor.session, tokenOf(invited))).status).toBe(200);
    expect(await rowOf(doctor.membershipId)).toMatchObject({
      status: 'ACTIVE',
      effective_until: null,
    });
    expect((await as(h, doctor.session, { clinicId: c.clinicId }).get('/clinic')).status).toBe(200);
    // A currently effective membership still blocks a duplicate invitation.
    expect((await invite(doctor.phone)).status).toBe(409);
  });

  it('a direct re-hire (TERMINATED → ACTIVE) also starts a new period; resuming a suspension keeps the window', async () => {
    const doctor = await addStaff(h, c.owner, c.clinicId, 'DOCTOR');
    const status = (s: string) =>
      owner().patch(`/clinic/members/${doctor.membershipId}/status`, {
        status: s,
        reason: 'change',
      });
    const until = new Date(h.clock().getTime() + MINUTE);
    await setWindow(doctor.membershipId, null, until);
    expect((await status('SUSPENDED')).status).toBe(204);
    expect((await status('ACTIVE')).status).toBe(204);
    expect((await rowOf(doctor.membershipId))?.effective_until?.toISOString()).toBe(
      until.toISOString(),
    );

    expect((await status('TERMINATED')).status).toBe(204);
    h.clock.advance(2 * MINUTE);
    expect((await status('ACTIVE')).status).toBe(204);
    expect(await rowOf(doctor.membershipId)).toMatchObject({
      status: 'ACTIVE',
      effective_until: null,
      terminated_at: null,
    });
    expect((await as(h, doctor.session, { clinicId: c.clinicId }).get('/clinic')).status).toBe(200);
    const [audit] = await h.db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'MEMBERSHIP_STATUS_CHANGED' AND target_id = ? ORDER BY id DESC LIMIT 1`,
      [doctor.membershipId],
    );
    expect(audit?.metadata).toMatchObject({
      from: 'TERMINATED',
      to: 'ACTIVE',
      previousPeriod: { effectiveUntil: until.toISOString() },
    });
  });

  it('rejects expired, revoked and already-used invitations uniformly', async () => {
    const usedPhone = testPhone();
    const used = await invite(usedPhone);
    const usedSession = await userSession(h, usedPhone);
    expect((await accept(usedSession, tokenOf(used))).status).toBe(200);
    expect(code(await accept(usedSession, tokenOf(used)))).toBe('INVITATION_INVALID');

    const revokedPhone = testPhone();
    const revoked = await invite(revokedPhone, 'RECEPTIONIST');
    await owner().post(
      `/clinic/invitations/${data<{ invitation: { id: string } }>(revoked).invitation.id}/revoke`,
    );
    expect(code(await accept(await userSession(h, revokedPhone), tokenOf(revoked)))).toBe(
      'INVITATION_INVALID',
    );

    const expiredPhone = testPhone();
    const expired = await invite(expiredPhone, 'RECEPTIONIST');
    h.clock.advance(169 * 60 * MINUTE);
    expect(code(await accept(await userSession(h, expiredPhone), tokenOf(expired)))).toBe(
      'INVITATION_INVALID',
    );
  });

  it('concurrent acceptances of one invitation create exactly one active membership', async () => {
    const phone = testPhone();
    const token = tokenOf(await invite(phone));
    const session = await userSession(h, phone);
    const results = await Promise.all(Array.from({ length: 5 }, () => accept(session, token)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200))
      expect(code(r)).toBe('INVITATION_INVALID');
    const rows = await h.db.query(
      `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND user_id = ? AND status = 'ACTIVE'`,
      [c.clinicId, session.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it('acceptance racing a closure approval ends consistently (clinic lock first, no deadlock)', async () => {
    const phone = testPhone();
    const token = tokenOf(await invite(phone));
    const session = await userSession(h, phone);
    const closure = data<{ id: string }>(
      await owner().post('/clinic/closure-requests', {
        reason: 'Retirement of the owner, closing permanently',
      }),
    ).id;
    const [accepted, approved] = await Promise.all([
      accept(session, token),
      as(h, admin).post(`/admin/closure-requests/${closure}/approve`, { reason: 'Plan reviewed' }),
    ]);
    expect(approved.status).toBe(204);
    expect(accepted.status).toBeLessThan(500);
    const [inv] = await h.db.query<{ status: string }>(
      'SELECT status FROM clinic_invitations WHERE clinic_id = ? AND invited_phone_e164 = ?',
      [c.clinicId, phone],
    );
    const members = await h.db.query(
      `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND user_id = ? AND status = 'ACTIVE'`,
      [c.clinicId, session.userId],
    );
    if (accepted.status === 200) {
      expect(inv?.status).toBe('ACCEPTED');
      expect(members).toHaveLength(1);
    } else {
      expect(code(accepted)).toBe('INVITATION_INVALID');
      expect(inv?.status).toBe('REVOKED');
      expect(members).toHaveLength(0);
    }
  });
});
