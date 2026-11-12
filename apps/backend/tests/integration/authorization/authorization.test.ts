import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NO_REQUEST_META } from '../../../src/shared/http/request-meta.js';
import { createHarness } from '../support/harness.js';
import {
  addMembership,
  body,
  createBranch,
  createClinic,
  createUser,
  grantGlobalRole,
  login,
} from '../support/fixtures.js';
import { enrollMfa } from '../support/mfa.js';

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => h.reset());

const { authz, resolver, membershipService } = h.container.services;
const principal = (userId: string, mfaVerified = false) => ({ userId, mfaVerified });

async function clinicCheck(
  userId: string,
  clinicId: string,
  permission: Parameters<typeof authz.check>[1],
  branchId: string | null = null,
) {
  const tenant = await resolver.resolve(userId, clinicId, branchId);
  return authz.check(principal(userId), permission, { tenant });
}

describe('global (platform) roles', () => {
  it('grants platform permissions to SUPER_ADMIN only with an MFA-verified session', async () => {
    const admin = await createUser(h.db);
    await grantGlobalRole(h.db, admin.id, 'SUPER_ADMIN');
    expect(await authz.check(principal(admin.id, false), 'platform.users.view')).toEqual({
      allowed: false,
      reason: 'MFA_ENROLLMENT_REQUIRED',
    });
    await h.db.execute(
      `INSERT INTO mfa_totp_credentials (user_id, secret_ciphertext, status) VALUES (?, 'x', 'ACTIVE')`,
      [admin.id],
    );
    expect(await authz.check(principal(admin.id, false), 'platform.users.view')).toEqual({
      allowed: false,
      reason: 'MFA_REQUIRED',
    });
    expect(await authz.check(principal(admin.id, true), 'platform.users.view')).toEqual({
      allowed: true,
    });
  });

  it('denies platform permissions to everyone else, MFA or not', async () => {
    const owner = await createUser(h.db);
    const clinic = await createClinic(h.db);
    await addMembership(h.db, { clinicId: clinic, userId: owner.id, role: 'CLINIC_OWNER' });
    expect(await authz.check(principal(owner.id, true), 'platform.users.manage_status')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
  });

  it('never gives SUPER_ADMIN implicit clinic access', async () => {
    const admin = await createUser(h.db);
    await grantGlobalRole(h.db, admin.id, 'SUPER_ADMIN');
    const clinic = await createClinic(h.db);
    await expect(resolver.resolve(admin.id, clinic, null)).rejects.toMatchObject({
      code: 'CLINIC_ACCESS_DENIED',
    });
    expect(await authz.check(principal(admin.id, true), 'clinic.medical_records.view')).toEqual({
      allowed: false,
      reason: 'CLINIC_CONTEXT_REQUIRED',
    });
  });

  it('end-to-end: a SUPER_ADMIN must enroll and verify 2FA before using admin endpoints', async () => {
    const adminUser = await createUser(h.db);
    await grantGlobalRole(h.db, adminUser.id, 'SUPER_ADMIN');
    const target = await createUser(h.db);
    const admin = await login(h, adminUser.phone);
    const suspend = () =>
      h
        .http()
        .post(`/api/v1/admin/users/${target.id}/suspend`)
        .set('Authorization', admin.bearer)
        .send({ reason: 'test suspension' });

    expect(body<{ error: { code: string } }>(await suspend()).error.code).toBe(
      'MFA_ENROLLMENT_REQUIRED',
    );
    await enrollMfa(h, admin); // enrollment confirms with a code → session becomes MFA-verified
    expect((await suspend()).status).toBe(204);
  });
});

describe('clinic memberships', () => {
  it('grants permissions of an active membership in that clinic only', async () => {
    const user = await createUser(h.db);
    const clinicA = await createClinic(h.db);
    const clinicB = await createClinic(h.db);
    await addMembership(h.db, { clinicId: clinicA, userId: user.id, role: 'RECEPTIONIST' });
    expect(await clinicCheck(user.id, clinicA, 'clinic.bookings.manage')).toEqual({
      allowed: true,
    });
    await expect(clinicCheck(user.id, clinicB, 'clinic.bookings.manage')).rejects.toMatchObject({
      code: 'CLINIC_ACCESS_DENIED',
    });
  });

  it('keeps roles per clinic: owner in A and doctor in B do not mix', async () => {
    const user = await createUser(h.db);
    const clinicA = await createClinic(h.db);
    const clinicB = await createClinic(h.db);
    await addMembership(h.db, { clinicId: clinicA, userId: user.id, role: 'CLINIC_OWNER' });
    await addMembership(h.db, { clinicId: clinicB, userId: user.id, role: 'DOCTOR' });
    expect(await clinicCheck(user.id, clinicA, 'clinic.settings.manage')).toEqual({
      allowed: true,
    });
    expect((await clinicCheck(user.id, clinicA, 'clinic.medical_records.view')).allowed).toBe(
      false,
    );
    expect(await clinicCheck(user.id, clinicB, 'clinic.medical_records.view')).toEqual({
      allowed: true,
    });
    expect((await clinicCheck(user.id, clinicB, 'clinic.settings.manage')).allowed).toBe(false);
  });

  it('denies a missing permission', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    await addMembership(h.db, { clinicId: clinic, userId: user.id, role: 'RECEPTIONIST' });
    expect(await clinicCheck(user.id, clinic, 'clinic.prescriptions.manage')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
  });

  it.each(['PENDING', 'SUSPENDED', 'TERMINATED'] as const)(
    'treats a %s membership as no membership',
    async (status) => {
      const user = await createUser(h.db);
      const clinic = await createClinic(h.db);
      await addMembership(h.db, {
        clinicId: clinic,
        userId: user.id,
        role: 'CLINIC_MANAGER',
        status,
      });
      await expect(resolver.resolve(user.id, clinic, null)).rejects.toMatchObject({
        code: 'CLINIC_ACCESS_DENIED',
      });
    },
  );

  it('honours effective dates', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    const now = h.clock();
    await addMembership(h.db, {
      clinicId: clinic,
      userId: user.id,
      role: 'DOCTOR',
      effectiveFrom: new Date(now.getTime() + 86_400_000),
    });
    await expect(resolver.resolve(user.id, clinic, null)).rejects.toMatchObject({
      code: 'CLINIC_ACCESS_DENIED',
    });
    h.clock.advance(2 * 86_400_000);
    await expect(resolver.resolve(user.id, clinic, null)).resolves.toMatchObject({
      clinicId: clinic,
    });

    const other = await createUser(h.db);
    await addMembership(h.db, {
      clinicId: clinic,
      userId: other.id,
      role: 'DOCTOR',
      effectiveUntil: new Date(h.clock().getTime() + 1000),
    });
    await expect(resolver.resolve(other.id, clinic, null)).resolves.toBeDefined();
    h.clock.advance(2000);
    await expect(resolver.resolve(other.id, clinic, null)).rejects.toMatchObject({
      code: 'CLINIC_ACCESS_DENIED',
    });
  });
});

describe('branches', () => {
  it('rejects a branch the member is not assigned to', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    const b1 = await createBranch(h.db, clinic, 'North');
    const b2 = await createBranch(h.db, clinic, 'South');
    await addMembership(h.db, {
      clinicId: clinic,
      userId: user.id,
      role: 'DOCTOR',
      branchScope: 'ASSIGNED',
      branchIds: [b1],
    });
    expect(await clinicCheck(user.id, clinic, 'clinic.medical_records.view', b1)).toEqual({
      allowed: true,
    });
    await expect(
      clinicCheck(user.id, clinic, 'clinic.medical_records.view', b2),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED' });
    expect(await clinicCheck(user.id, clinic, 'clinic.medical_records.view')).toEqual({
      allowed: false,
      reason: 'BRANCH_CONTEXT_REQUIRED',
    });
  });

  it('rejects a branch id belonging to another clinic even for all-branch members', async () => {
    const user = await createUser(h.db);
    const clinicA = await createClinic(h.db);
    const clinicB = await createClinic(h.db);
    const branchB = await createBranch(h.db, clinicB);
    await addMembership(h.db, { clinicId: clinicA, userId: user.id, role: 'CLINIC_OWNER' });
    await expect(resolver.resolve(user.id, clinicA, branchB)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
    });
  });
});

describe('changes take effect immediately', () => {
  it('a role-permission change applies to the next check', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    await addMembership(h.db, { clinicId: clinic, userId: user.id, role: 'RECEPTIONIST' });
    expect(await clinicCheck(user.id, clinic, 'clinic.payments.manage')).toEqual({ allowed: true });
    await h.db.execute(
      `DELETE FROM role_permissions WHERE role_code = 'RECEPTIONIST' AND permission_code = 'clinic.payments.manage'`,
    );
    try {
      expect(await clinicCheck(user.id, clinic, 'clinic.payments.manage')).toEqual({
        allowed: false,
        reason: 'NO_PERMISSION',
      });
    } finally {
      await h.db.execute(
        `INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES ('RECEPTIONIST', 'CLINIC', 'clinic.payments.manage', 'CLINIC')`,
      );
    }
  });

  it('a membership suspension blocks the very next API request, without touching other clinics or the account', async () => {
    const user = await createUser(h.db);
    const clinicA = await createClinic(h.db);
    const clinicB = await createClinic(h.db);
    const mA = await addMembership(h.db, {
      clinicId: clinicA,
      userId: user.id,
      role: 'RECEPTIONIST',
    });
    await addMembership(h.db, { clinicId: clinicB, userId: user.id, role: 'RECEPTIONIST' });
    const s = await login(h, user.phone);
    const perms = (clinicId: string) =>
      h
        .http()
        .get('/api/v1/me/permissions')
        .set('Authorization', s.bearer)
        .set('X-Clinic-Id', clinicId);

    expect((await perms(clinicA)).status).toBe(200);
    await h.db.execute(`UPDATE clinic_memberships SET status = 'SUSPENDED' WHERE id = ?`, [mA]);
    expect(body<{ error: { code: string } }>(await perms(clinicA)).error.code).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect((await perms(clinicB)).status).toBe(200);
    expect((await h.http().get('/api/v1/me').set('Authorization', s.bearer)).status).toBe(200);
  });

  it('revoking a global role applies to the next check', async () => {
    const admin = await createUser(h.db);
    await grantGlobalRole(h.db, admin.id, 'SUPER_ADMIN');
    expect(await authz.check(principal(admin.id, true), 'platform.users.view')).toEqual({
      allowed: true,
    });
    await h.db.execute(
      `DELETE FROM user_global_roles WHERE user_id = ? AND role_code = 'SUPER_ADMIN'`,
      [admin.id],
    );
    expect(await authz.check(principal(admin.id, true), 'platform.users.view')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
  });

  it('a suspended account is rejected on the next request', async () => {
    const user = await createUser(h.db);
    const s = await login(h, user.phone);
    await h.db.execute(`UPDATE users SET status = 'SUSPENDED' WHERE id = ?`, [user.id]);
    const res = await h.http().get('/api/v1/me').set('Authorization', s.bearer);
    expect(res.status).toBe(403);
    expect(body<{ error: { code: string } }>(res).error.code).toBe('ACCOUNT_NOT_ACTIVE');
  });
});

describe('membership management (privilege escalation rules)', () => {
  async function setup() {
    const clinic = await createClinic(h.db);
    const owner = await createUser(h.db);
    const manager = await createUser(h.db);
    const target = await createUser(h.db);
    await addMembership(h.db, { clinicId: clinic, userId: owner.id, role: 'CLINIC_OWNER' });
    await addMembership(h.db, { clinicId: clinic, userId: manager.id, role: 'CLINIC_MANAGER' });
    return { clinic, owner, manager, target };
  }
  const grant = (
    actorId: string,
    clinicId: string,
    userId: string,
    role: 'CLINIC_OWNER' | 'CLINIC_MANAGER' | 'DOCTOR' | 'RECEPTIONIST',
    mfa = false,
  ) =>
    membershipService.grant(
      principal(actorId, mfa),
      { clinicId, userId, role, branchScope: 'ALL' },
      NO_REQUEST_META,
    );

  it('lets an owner grant manager/doctor/receptionist and records history + audit', async () => {
    const { clinic, owner, target } = await setup();
    const id = await grant(owner.id, clinic, target.id, 'DOCTOR');
    const events = await h.db.query<{ to_status: string }>(
      'SELECT to_status FROM clinic_membership_events WHERE membership_id = ?',
      [id],
    );
    expect(events).toEqual([{ to_status: 'ACTIVE' }]);
    const audit = await h.db.query<{ action: string }>(
      'SELECT action FROM audit_events WHERE target_id = ?',
      [id],
    );
    expect(audit).toEqual([{ action: 'MEMBERSHIP_CREATED' }]);
  });

  it('prevents a manager from granting OWNER or MANAGER', async () => {
    const { clinic, manager, target } = await setup();
    await expect(grant(manager.id, clinic, target.id, 'CLINIC_OWNER')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(grant(manager.id, clinic, target.id, 'CLINIC_MANAGER')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(grant(manager.id, clinic, target.id, 'RECEPTIONIST')).resolves.toBeDefined();
  });

  it('prevents an owner from creating another owner (platform-only)', async () => {
    const { clinic, owner, target } = await setup();
    await expect(grant(owner.id, clinic, target.id, 'CLINIC_OWNER')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('prevents anyone from changing their own memberships', async () => {
    const { clinic, owner } = await setup();
    await expect(grant(owner.id, clinic, owner.id, 'DOCTOR')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('prevents receptionists and members of other clinics from managing memberships', async () => {
    const { clinic, target } = await setup();
    const receptionist = await createUser(h.db);
    await addMembership(h.db, { clinicId: clinic, userId: receptionist.id, role: 'RECEPTIONIST' });
    await expect(grant(receptionist.id, clinic, target.id, 'DOCTOR')).rejects.toMatchObject({
      statusCode: 403,
    });

    const otherOwner = await createUser(h.db);
    const otherClinic = await createClinic(h.db);
    await addMembership(h.db, {
      clinicId: otherClinic,
      userId: otherOwner.id,
      role: 'CLINIC_OWNER',
    });
    await expect(grant(otherOwner.id, clinic, target.id, 'DOCTOR')).rejects.toMatchObject({
      code: 'CLINIC_ACCESS_DENIED',
    });
  });

  it('lets an MFA-verified super admin grant CLINIC_OWNER', async () => {
    const { clinic, target } = await setup();
    const admin = await createUser(h.db);
    await grantGlobalRole(h.db, admin.id, 'SUPER_ADMIN');
    await expect(grant(admin.id, clinic, target.id, 'CLINIC_OWNER', false)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(grant(admin.id, clinic, target.id, 'CLINIC_OWNER', true)).resolves.toBeDefined();
  });

  it('terminating a membership revokes that clinic only, keeps history, and clears the remembered context', async () => {
    const { clinic, owner, target } = await setup();
    const otherClinic = await createClinic(h.db);
    await addMembership(h.db, { clinicId: otherClinic, userId: target.id, role: 'DOCTOR' });
    const id = await grant(owner.id, clinic, target.id, 'RECEPTIONIST');
    const s = await login(h, target.phone);
    await h
      .http()
      .post('/api/v1/context/clinic')
      .set('Authorization', s.bearer)
      .send({ clinicId: clinic });

    await membershipService.changeStatus(
      principal(owner.id),
      { clinicId: clinic, membershipId: id, status: 'TERMINATED', reason: 'left' },
      NO_REQUEST_META,
    );

    expect(
      (await h.http().get('/api/v1/context/branches').set('Authorization', s.bearer)).status,
    ).toBe(400); // context cleared
    expect(
      body<{ error: { code: string } }>(
        await h
          .http()
          .get('/api/v1/context/branches')
          .set('Authorization', s.bearer)
          .set('X-Clinic-Id', clinic),
      ).error.code,
    ).toBe('CLINIC_ACCESS_DENIED');
    expect(
      (
        await h
          .http()
          .get('/api/v1/context/branches')
          .set('Authorization', s.bearer)
          .set('X-Clinic-Id', otherClinic)
      ).status,
    ).toBe(200);
    const history = await h.db.query<{ from_status: string | null; to_status: string }>(
      'SELECT from_status, to_status FROM clinic_membership_events WHERE membership_id = ? ORDER BY id',
      [id],
    );
    expect(history).toEqual([
      { from_status: null, to_status: 'ACTIVE' },
      { from_status: 'ACTIVE', to_status: 'TERMINATED' },
    ]);
    const [row] = await h.db.query<{ status: string; terminated_at: Date | null }>(
      'SELECT status, terminated_at FROM clinic_memberships WHERE id = ?',
      [id],
    );
    expect(row?.status).toBe('TERMINATED');
    expect(row?.terminated_at).not.toBeNull();
  });

  it('cannot manage a membership id that belongs to another clinic', async () => {
    const { clinic, owner } = await setup();
    const otherClinic = await createClinic(h.db);
    const someone = await createUser(h.db);
    const foreign = await addMembership(h.db, {
      clinicId: otherClinic,
      userId: someone.id,
      role: 'DOCTOR',
    });
    await expect(
      membershipService.changeStatus(
        principal(owner.id),
        { clinicId: clinic, membershipId: foreign, status: 'TERMINATED', reason: 'x' },
        NO_REQUEST_META,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses invalid status transitions', async () => {
    const { clinic, owner, target } = await setup();
    const id = await grant(owner.id, clinic, target.id, 'DOCTOR');
    await expect(
      membershipService.changeStatus(
        principal(owner.id),
        { clinicId: clinic, membershipId: id, status: 'PENDING', reason: 'x' },
        NO_REQUEST_META,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});
