import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { addMembership, createUser, grantGlobalRole, type LoggedIn } from '../support/fixtures.js';
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

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let c: OnboardedClinic;
let recipient: LoggedIn;
let recipientPhone: string;

beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  c = await onboardClinic(h, admin, { paid: true });
  const u = await createUser(h.db);
  recipientPhone = u.phone;
  recipient = await userSession(h, u.phone);
});

const owner = () => as(h, c.owner, { clinicId: c.clinicId });
const ownersOf = async (clinicId: string) =>
  (
    await h.db.query<{ user_id: string }>(
      `SELECT user_id FROM clinic_memberships WHERE clinic_id = ? AND role_code = 'CLINIC_OWNER' AND status = 'ACTIVE'`,
      [clinicId],
    )
  ).map((r) => r.user_id);

async function readyForApproval(): Promise<string> {
  const id = data<{ id: string }>(
    await owner().post('/clinic/ownership-transfers', {
      phone: recipientPhone,
      reason: 'Selling the practice',
    }),
  ).id;
  expect((await as(h, recipient).post(`/ownership-transfers/${id}/accept`)).status).toBe(200);
  expect(
    (await as(h, c.owner).upload(`/ownership-transfers/${id}/documents`, 'TRANSFER_AGREEMENT'))
      .status,
  ).toBe(201);
  expect(
    (
      await as(h, admin).post(`/admin/ownership-transfers/${id}/identity`, {
        result: 'VERIFIED',
        note: 'ID checked in person',
      })
    ).status,
  ).toBe(200);
  return id;
}

describe('ownership transfer', () => {
  it('owner initiates → recipient accepts → admin verifies identity and approves → atomic swap', async () => {
    const otherClinic = await onboardClinic(h, admin, { owner: c.owner });
    await addStaff(h, c.owner, otherClinic.clinicId, 'DOCTOR', {
      member: { session: recipient, phone: recipientPhone },
    });
    const id = await readyForApproval();
    expect(await ownersOf(c.clinicId)).toEqual([c.owner.userId]); // nothing changed before final approval

    const approved = await as(h, admin).post(`/admin/ownership-transfers/${id}/approve`, {
      reason: 'All checks passed',
    });
    expect(data<{ status: string }>(approved).status).toBe('COMPLETED');
    expect(await ownersOf(c.clinicId)).toEqual([recipient.userId]);

    // Previous owner: no role left in this clinic, account and other clinic untouched.
    expect(code(await as(h, c.owner, { clinicId: c.clinicId }).get('/clinic'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect((await as(h, c.owner, { clinicId: otherClinic.clinicId }).get('/clinic')).status).toBe(
      200,
    );
    expect((await as(h, c.owner).get('/me')).status).toBe(200);
    // New owner operates the clinic with their own session (no credentials/sessions transferred).
    expect((await as(h, recipient, { clinicId: c.clinicId }).get('/clinic/members')).status).toBe(
      200,
    );
    const sessions = await h.db.query<{ user_id: string }>(
      'SELECT DISTINCT user_id FROM sessions WHERE id IN (?, ?)',
      [c.owner.sessionId, recipient.sessionId],
    );
    expect(sessions).toHaveLength(2);

    const history = data<{ history: { event: string }[] }>(
      await as(h, admin).get(`/admin/ownership-transfers/${id}`),
    ).history;
    expect(history.map((x) => x.event)).toEqual([
      'INITIATED',
      'ACCEPTED',
      'IDENTITY_VERIFIED',
      'COMPLETED',
    ]);
    const audit = await h.db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE clinic_id = ? AND action IN ('OWNERSHIP_TRANSFER_CHANGED', 'MEMBERSHIP_STATUS_CHANGED', 'MEMBERSHIP_CREATED')`,
      [c.clinicId],
    );
    expect(audit.length).toBeGreaterThanOrEqual(5);
  });

  it('cannot bypass the recipient or the Super Admin', async () => {
    const id = data<{ id: string }>(
      await owner().post('/clinic/ownership-transfers', { phone: recipientPhone }),
    ).id;
    expect(
      code(
        await as(h, admin).post(`/admin/ownership-transfers/${id}/approve`, {
          reason: 'too early',
        }),
      ),
    ).toBe('INVALID_TRANSITION');
    expect(
      (
        await as(h, c.owner).post(`/admin/ownership-transfers/${id}/approve`, {
          reason: 'self approve',
        })
      ).status,
    ).toBe(403);
    expect((await as(h, c.owner).post(`/ownership-transfers/${id}/accept`)).status).toBe(404); // only the recipient accepts
    await as(h, recipient).post(`/ownership-transfers/${id}/accept`);
    expect(
      code(
        await as(h, admin).post(`/admin/ownership-transfers/${id}/approve`, {
          reason: 'no identity check',
        }),
      ),
    ).toBe('IDENTITY_NOT_VERIFIED');
    await as(h, admin).post(`/admin/ownership-transfers/${id}/identity`, {
      result: 'VERIFIED',
      note: 'checked',
    });
    expect(
      code(
        await as(h, admin).post(`/admin/ownership-transfers/${id}/approve`, {
          reason: 'no agreement',
        }),
      ),
    ).toBe('DOCUMENTS_MISSING');
    expect(await ownersOf(c.clinicId)).toEqual([c.owner.userId]);
  });

  it('a Super Admin who is a party cannot review the transfer', async () => {
    const recipientAdmin = await adminSession(h);
    const phone = (
      await h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM users WHERE id = ?', [
        recipientAdmin.userId,
      ])
    )[0]!.phone_e164;
    const id = data<{ id: string }>(
      await owner().post('/clinic/ownership-transfers', { phone }),
    ).id;
    await as(h, recipientAdmin).post(`/ownership-transfers/${id}/accept`);
    expect(
      code(
        await as(h, recipientAdmin).post(`/admin/ownership-transfers/${id}/identity`, {
          result: 'VERIFIED',
          note: 'myself',
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('concurrent approvals complete the transfer exactly once', async () => {
    const id = await readyForApproval();
    const admin2 = await adminSession(h);
    const results = await Promise.all(
      [admin, admin2].map((a) =>
        as(h, a).post(`/admin/ownership-transfers/${id}/approve`, {
          reason: 'concurrent approval',
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ownersOf(c.clinicId)).toEqual([recipient.userId]);
    expect(
      await h.db.query(
        `SELECT id FROM clinic_ownership_transfer_history WHERE transfer_id = ? AND event = 'COMPLETED'`,
        [id],
      ),
    ).toHaveLength(1);
  });

  it('requires an active, verified recipient; only one open transfer; non-owners cannot initiate; expiry', async () => {
    expect(code(await owner().post('/clinic/ownership-transfers', { phone: '+12025550142' }))).toBe(
      'RECIPIENT_NOT_ELIGIBLE',
    );
    const pending = await createUser(h.db, { status: 'PENDING_VERIFICATION' });
    expect(code(await owner().post('/clinic/ownership-transfers', { phone: pending.phone }))).toBe(
      'RECIPIENT_NOT_ELIGIBLE',
    );
    const manager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER');
    expect(
      (
        await as(h, manager.session, { clinicId: c.clinicId }).post('/clinic/ownership-transfers', {
          phone: recipientPhone,
        })
      ).status,
    ).toBe(403);
    const id = data<{ id: string }>(
      await owner().post('/clinic/ownership-transfers', { phone: recipientPhone }),
    ).id;
    expect(
      (await owner().post('/clinic/ownership-transfers', { phone: recipientPhone })).status,
    ).toBe(409);
    h.clock.advance(337 * 3_600_000);
    const fresh = await userSession(h, recipientPhone);
    expect(code(await as(h, fresh).post(`/ownership-transfers/${id}/accept`))).toBe(
      'TRANSFER_EXPIRED',
    );
  });

  it('decline and cancel end the transfer without changes', async () => {
    const id = data<{ id: string }>(
      await owner().post('/clinic/ownership-transfers', { phone: recipientPhone }),
    ).id;
    expect(
      data<{ status: string }>(await as(h, recipient).post(`/ownership-transfers/${id}/decline`))
        .status,
    ).toBe('DECLINED');
    const id2 = data<{ id: string }>(
      await owner().post('/clinic/ownership-transfers', { phone: recipientPhone }),
    ).id;
    expect((await owner().post(`/clinic/ownership-transfers/${id2}/cancel`)).status).toBe(204);
    expect(await ownersOf(c.clinicId)).toEqual([c.owner.userId]);
  });

  it('transfer documents are private to the parties and reviewers', async () => {
    const id = data<{ id: string }>(
      await owner().post('/clinic/ownership-transfers', { phone: recipientPhone }),
    ).id;
    const doc = data<{ id: string }>(
      await as(h, recipient).upload(`/ownership-transfers/${id}/documents`, 'NEW_OWNER_IDENTITY'),
    );
    const stranger = await userSession(h);
    expect((await as(h, stranger).get(`/ownership-transfers/${id}`)).status).toBe(404);
    expect(
      (await as(h, stranger).get(`/ownership-transfers/${id}/documents/${doc.id}/content`)).status,
    ).toBe(404);
    expect(
      (await as(h, c.owner).get(`/ownership-transfers/${id}/documents/${doc.id}/content`)).status,
    ).toBe(200);
    expect(
      (await as(h, admin).get(`/admin/ownership-transfers/${id}/documents/${doc.id}/content`))
        .status,
    ).toBe(200);
  });

  // Task 03.1 decision C (ADR-031): every role of the previous owner in THIS clinic is revoked;
  // the account, global roles and other clinics are untouched; the new owner may re-grant a role
  // through the normal invitation workflow (never CLINIC_OWNER).
  it("revokes all of the previous owner's roles here only; the new owner can re-invite them with a new role", async () => {
    const prev = await createUser(h.db);
    await grantGlobalRole(h.db, prev.id, 'PATIENT');
    const prevSession = await userSession(h, prev.phone);
    c = await onboardClinic(h, admin, { owner: prevSession, paid: true });
    const other = await onboardClinic(h, admin, { owner: prevSession, paid: true });
    await addMembership(h.db, { clinicId: c.clinicId, userId: prev.id, role: 'DOCTOR' });
    const rolesOf = (clinicId: string) =>
      h.db.query<{ role_code: string; status: string }>(
        'SELECT role_code, status FROM clinic_memberships WHERE clinic_id = ? AND user_id = ? ORDER BY role_code',
        [clinicId, prev.id],
      );

    const id = await readyForApproval();
    expect(
      (
        await as(h, admin).post(`/admin/ownership-transfers/${id}/approve`, {
          reason: 'All checks passed',
        })
      ).status,
    ).toBe(200);

    expect(await rolesOf(c.clinicId)).toEqual([
      { role_code: 'CLINIC_OWNER', status: 'TERMINATED' },
      { role_code: 'DOCTOR', status: 'TERMINATED' },
    ]);
    expect(await rolesOf(other.clinicId)).toEqual([
      { role_code: 'CLINIC_OWNER', status: 'ACTIVE' },
    ]);
    expect(await h.db.query('SELECT status FROM users WHERE id = ?', [prev.id])).toEqual([
      { status: 'ACTIVE' },
    ]);
    expect(
      await h.db.query('SELECT role_code FROM user_global_roles WHERE user_id = ?', [prev.id]),
    ).toEqual([{ role_code: 'PATIENT' }]);
    expect(code(await as(h, prevSession, { clinicId: c.clinicId }).get('/clinic'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );

    // The new owner cannot hand ownership back by invitation …
    const asNewOwner = as(h, recipient, { clinicId: c.clinicId });
    expect(
      (
        await asNewOwner.post('/clinic/invitations', {
          phone: prev.phone,
          role: 'CLINIC_OWNER',
          branchScope: 'ALL',
          branchIds: [],
        })
      ).status,
    ).toBe(400);
    // … but may grant a new, ordinary role through the normal workflow.
    await addStaff(h, recipient, c.clinicId, 'DOCTOR', {
      member: { session: prevSession, phone: prev.phone },
    });
    expect(await rolesOf(c.clinicId)).toEqual([
      { role_code: 'CLINIC_OWNER', status: 'TERMINATED' },
      { role_code: 'DOCTOR', status: 'ACTIVE' },
    ]);
    expect(await ownersOf(c.clinicId)).toEqual([recipient.userId]);
    const asPrev = as(h, prevSession, { clinicId: c.clinicId });
    expect((await asPrev.get('/clinic')).status).toBe(200);
    expect(code(await asPrev.post('/clinic/ownership-transfers', { phone: recipientPhone }))).toBe(
      'FORBIDDEN',
    );
  });
});
