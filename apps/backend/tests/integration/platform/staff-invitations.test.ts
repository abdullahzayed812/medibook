import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_REQUEST_META } from '../../../src/shared/http/request-meta.js';
import { createHarness } from '../support/harness.js';
import { body, testPhone, type LoggedIn } from '../support/fixtures.js';
import {
  addStaff,
  adminSession,
  as,
  code,
  createPlan,
  data,
  onboardClinic,
  userSession,
  type OnboardedClinic,
} from '../support/platform.js';

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
const invite = (s: LoggedIn, payload: object) =>
  as(h, s, { clinicId: c.clinicId }).post('/clinic/invitations', {
    branchScope: 'ALL',
    branchIds: [],
    ...payload,
  });

describe('invitations', () => {
  it('invite → invitee sees it → accepts → active member with the bound role and branches; audited without tokens', async () => {
    const phone = testPhone();
    const res = await invite(c.owner, {
      phone,
      role: 'DOCTOR',
      branchScope: 'ASSIGNED',
      branchIds: [c.branchId],
    });
    expect(res.status).toBe(201);
    const { token, invitation } = data<{
      token: string;
      invitation: { id: string; invitedPhone: string; status: string };
    }>(res);
    expect(invitation.invitedPhone).not.toContain(phone.slice(-6, -4));
    const invitee = await userSession(h, phone);
    expect(
      data<{ id: string }[]>(await as(h, invitee).get('/me/invitations')).map((i) => i.id),
    ).toEqual([invitation.id]);
    const accepted = await as(h, invitee).post('/invitations/accept', { token });
    expect(data<{ role: string }>(accepted).role).toBe('DOCTOR');
    const memberships = data<
      { role: string; status: string; branchScope: string; branchIds: string[] }[]
    >(await as(h, invitee).get('/me/memberships'));
    expect(memberships).toEqual([
      expect.objectContaining({
        role: 'DOCTOR',
        status: 'ACTIVE',
        branchScope: 'ASSIGNED',
        branchIds: [c.branchId],
      }),
    ]);
    // Single use.
    expect(code(await as(h, invitee).post('/invitations/accept', { token }))).toBe(
      'INVITATION_INVALID',
    );
    // Tokens and hashes never leak into audit, outbox or listings.
    const hash = (
      await h.db.query<{ token_hash: string }>('SELECT token_hash FROM clinic_invitations')
    )[0]!.token_hash;
    const stored =
      JSON.stringify(await h.db.query('SELECT metadata FROM audit_events')) +
      JSON.stringify(await h.db.query('SELECT payload FROM domain_events'));
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(hash);
    expect(JSON.stringify((await owner().get('/clinic/invitations')).body)).not.toMatch(/token/i);
  });

  it('only the invited phone can accept; manipulated or unknown tokens fail uniformly', async () => {
    const { token } = data<{ token: string }>(
      await invite(c.owner, { phone: testPhone(), role: 'RECEPTIONIST' }),
    );
    const stranger = await userSession(h);
    expect(code(await as(h, stranger).post('/invitations/accept', { token }))).toBe(
      'INVITATION_INVALID',
    );
    expect(
      code(await as(h, stranger).post('/invitations/accept', { token: `${token.slice(0, -2)}xx` })),
    ).toBe('INVITATION_INVALID');
  });

  it('expired and revoked invitations cannot be accepted', async () => {
    const phone1 = testPhone();
    const expired = data<{ token: string }>(
      await invite(c.owner, { phone: phone1, role: 'RECEPTIONIST' }),
    );
    const phone2 = testPhone();
    const revoked = data<{ token: string; invitation: { id: string } }>(
      await invite(c.owner, { phone: phone2, role: 'RECEPTIONIST' }),
    );
    expect((await owner().post(`/clinic/invitations/${revoked.invitation.id}/revoke`)).status).toBe(
      204,
    );
    expect(
      code(
        await as(h, await userSession(h, phone2)).post('/invitations/accept', {
          token: revoked.token,
        }),
      ),
    ).toBe('INVITATION_INVALID');
    h.clock.advance(169 * 3_600_000);
    const late = await userSession(h, phone1);
    expect(code(await as(h, late).post('/invitations/accept', { token: expired.token }))).toBe(
      'INVITATION_INVALID',
    );
  });

  it('declining is final', async () => {
    const phone = testPhone();
    const { token } = data<{ token: string }>(
      await invite(c.owner, { phone, role: 'RECEPTIONIST' }),
    );
    const invitee = await userSession(h, phone);
    expect((await as(h, invitee).post('/invitations/decline', { token })).status).toBe(204);
    expect(code(await as(h, invitee).post('/invitations/accept', { token }))).toBe(
      'INVITATION_INVALID',
    );
  });

  it('prevents escalation through invitations', async () => {
    const manager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER');
    expect(
      (await invite(manager.session, { phone: testPhone(), role: 'CLINIC_MANAGER' })).status,
    ).toBe(403);
    expect((await invite(c.owner, { phone: testPhone(), role: 'CLINIC_OWNER' })).status).toBe(400); // not invitable at all
    const doctor = await addStaff(h, c.owner, c.clinicId, 'DOCTOR');
    expect(
      (await invite(doctor.session, { phone: testPhone(), role: 'RECEPTIONIST' })).status,
    ).toBe(403);
    expect(
      (await invite(doctor.session, { phone: doctor.phone, role: 'CLINIC_MANAGER' })).status,
    ).toBe(403);
    expect(
      (
        await invite(c.owner, {
          phone: (
            await h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM users WHERE id = ?', [
              c.owner.userId,
            ])
          )[0]!.phone_e164,
          role: 'DOCTOR',
        })
      ).status,
    ).toBe(403);
  });

  it('an invitation dies if the inviter lost the authority to grant that role', async () => {
    const manager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER');
    const phone = testPhone();
    const { token } = data<{ token: string }>(
      await invite(manager.session, { phone, role: 'RECEPTIONIST' }),
    );
    await owner().patch(`/clinic/members/${manager.membershipId}/status`, {
      status: 'SUSPENDED',
      reason: 'under review',
    });
    expect(
      code(await as(h, await userSession(h, phone)).post('/invitations/accept', { token })),
    ).toBe('INVITATION_INVALID');
  });

  it('enforces the plan member limit at invitation and acceptance', async () => {
    const planId = await createPlan(h, admin, { maxMembers: 2 });
    const small = await onboardClinic(h, admin, { planId });
    const p1 = testPhone();
    const p2 = testPhone();
    const t1 = data<{ token: string }>(
      await as(h, small.owner, { clinicId: small.clinicId }).post('/clinic/invitations', {
        phone: p1,
        role: 'DOCTOR',
        branchScope: 'ALL',
        branchIds: [],
      }),
    ).token;
    const t2 = data<{ token: string }>(
      await as(h, small.owner, { clinicId: small.clinicId }).post('/clinic/invitations', {
        phone: p2,
        role: 'DOCTOR',
        branchScope: 'ALL',
        branchIds: [],
      }),
    ).token;
    expect(
      (await as(h, await userSession(h, p1)).post('/invitations/accept', { token: t1 })).status,
    ).toBe(200);
    expect(
      code(await as(h, await userSession(h, p2)).post('/invitations/accept', { token: t2 })),
    ).toBe('PLAN_LIMIT_REACHED');
  });
});

describe('membership management', () => {
  it('deactivates, reactivates, suspends and terminates with immediate effect and history', async () => {
    const staff = await addStaff(h, c.owner, c.clinicId, 'RECEPTIONIST');
    const change = (status: string) =>
      owner().patch(`/clinic/members/${staff.membershipId}/status`, {
        status,
        reason: 'scheduled change',
      });
    expect((await change('INACTIVE')).status).toBe(204);
    expect(code(await as(h, staff.session, { clinicId: c.clinicId }).get('/clinic'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect((await change('ACTIVE')).status).toBe(204);
    expect((await as(h, staff.session, { clinicId: c.clinicId }).get('/clinic')).status).toBe(200);
    expect((await change('SUSPENDED')).status).toBe(204);
    expect((await change('TERMINATED')).status).toBe(204);
    expect(code(await change('SUSPENDED'))).toBe('INVALID_TRANSITION');
    const history = await h.db.query<{ to_status: string }>(
      'SELECT to_status FROM clinic_membership_events WHERE membership_id = ? ORDER BY id',
      [staff.membershipId],
    );
    expect(history.map((x) => x.to_status)).toEqual([
      'ACTIVE',
      'INACTIVE',
      'ACTIVE',
      'SUSPENDED',
      'TERMINATED',
    ]);
    expect(
      await h.db.query('SELECT id FROM users WHERE id = ?', [staff.session.userId]),
    ).toHaveLength(1);
  });

  it('a manager cannot promote themselves or touch owners; a doctor cannot grant themselves anything', async () => {
    const manager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER');
    const doctor = await addStaff(h, c.owner, c.clinicId, 'DOCTOR');
    const ownerMembership = (
      await h.db.query<{ id: string }>(
        `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND role_code = 'CLINIC_OWNER'`,
        [c.clinicId],
      )
    )[0]!.id;
    const asManager = as(h, manager.session, { clinicId: c.clinicId });
    expect(
      (
        await asManager.put(`/clinic/members/${manager.membershipId}/branches`, {
          branchScope: 'ALL',
          branchIds: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await asManager.patch(`/clinic/members/${ownerMembership}/status`, {
          status: 'SUSPENDED',
          reason: 'coup attempt',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await asManager.patch(`/clinic/members/${doctor.membershipId}/status`, {
          status: 'SUSPENDED',
          reason: 'allowed action',
        })
      ).status,
    ).toBe(204);
    await owner().patch(`/clinic/members/${doctor.membershipId}/status`, {
      status: 'ACTIVE',
      reason: 'restore doctor',
    });
    const asDoctor = as(h, doctor.session, { clinicId: c.clinicId });
    expect(
      (
        await asDoctor.put(`/clinic/members/${doctor.membershipId}/branches`, {
          branchScope: 'ALL',
          branchIds: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await asDoctor.patch(`/clinic/members/${doctor.membershipId}/public-listing`, {
          publicListing: true,
        })
      ).status,
    ).toBe(403);
    expect((await asDoctor.get('/clinic/members')).status).toBe(403);
  });

  it('protects the last active owner (also under concurrent mutual removal)', async () => {
    const ownerMembership = (
      await h.db.query<{ id: string }>(
        `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND role_code = 'CLINIC_OWNER'`,
        [c.clinicId],
      )
    )[0]!.id;
    expect(code(await as(h, admin, { clinicId: c.clinicId }).get('/clinic'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    const second = await userSession(h);
    const { membershipService } = h.container.services;
    const secondId = await membershipService.grant(
      { userId: admin.userId, mfaVerified: true },
      { clinicId: c.clinicId, userId: second.userId, role: 'CLINIC_OWNER', branchScope: 'ALL' },
      NO_REQUEST_META,
    );
    // Owners terminate each other at the same time: at most one may succeed.
    const results = await Promise.allSettled([
      membershipService.changeStatus(
        { userId: c.owner.userId, mfaVerified: false },
        { clinicId: c.clinicId, membershipId: secondId, status: 'TERMINATED', reason: 'race' },
        NO_REQUEST_META,
      ),
      membershipService.changeStatus(
        { userId: second.userId, mfaVerified: false },
        {
          clinicId: c.clinicId,
          membershipId: ownerMembership,
          status: 'TERMINATED',
          reason: 'race',
        },
        NO_REQUEST_META,
      ),
    ]);
    // Owners cannot manage owners (platform-only), so both fail; via the platform the last-owner guard applies:
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const platformActor = { userId: admin.userId, mfaVerified: true };
    const race = await Promise.allSettled([
      membershipService.changeStatus(
        platformActor,
        { clinicId: c.clinicId, membershipId: secondId, status: 'TERMINATED', reason: 'race' },
        NO_REQUEST_META,
      ),
      membershipService.changeStatus(
        platformActor,
        {
          clinicId: c.clinicId,
          membershipId: ownerMembership,
          status: 'TERMINATED',
          reason: 'race',
        },
        NO_REQUEST_META,
      ),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'LAST_ACTIVE_OWNER' },
    });
    const owners = await h.db.query(
      `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND role_code = 'CLINIC_OWNER' AND status = 'ACTIVE'`,
      [c.clinicId],
    );
    expect(owners).toHaveLength(1);
  });

  it('validates branch assignments against the clinic and lists members with masked phones', async () => {
    const other = await onboardClinic(h, admin);
    const staff = await addStaff(h, c.owner, c.clinicId, 'RECEPTIONIST');
    expect(
      (
        await owner().put(`/clinic/members/${staff.membershipId}/branches`, {
          branchScope: 'ASSIGNED',
          branchIds: [other.branchId],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner().put(`/clinic/members/${staff.membershipId}/branches`, {
          branchScope: 'ASSIGNED',
          branchIds: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner().put(`/clinic/members/${staff.membershipId}/branches`, {
          branchScope: 'ASSIGNED',
          branchIds: [c.branchId],
        })
      ).status,
    ).toBe(204);
    const list = body<{ data: { phone: string; branchIds: string[]; role: string }[] }>(
      await owner().get('/clinic/members'),
    );
    expect(list.data).toHaveLength(2);
    expect(list.data.every((m) => m.phone.includes('•'))).toBe(true);
    expect(list.data.find((m) => m.role === 'RECEPTIONIST')?.branchIds).toEqual([c.branchId]);
  });
});
