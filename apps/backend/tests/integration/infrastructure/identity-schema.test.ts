import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../../../src/modules/access/index.js';
import { createHarness } from '../support/harness.js';
import { addMembership, createBranch, createClinic, createUser } from '../support/fixtures.js';

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => h.reset());

describe('identity schema', () => {
  it('seeded roles, permissions and role_permissions match the code catalog exactly', async () => {
    const roles = await h.db.query<{ code: string; scope: string }>(
      'SELECT code, scope FROM roles ORDER BY code',
    );
    expect(roles).toEqual(
      Object.entries(ROLES)
        .map(([code, r]) => ({ code, scope: r.scope }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );

    const permissions = await h.db.query<{ code: string; scope: string }>(
      'SELECT code, scope FROM permissions ORDER BY code',
    );
    expect(permissions).toEqual(
      Object.entries(PERMISSIONS)
        .map(([code, p]) => ({ code, scope: p.scope }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );

    const mapping = await h.db.query<{ role_code: string; permission_code: string }>(
      'SELECT role_code, permission_code FROM role_permissions ORDER BY role_code, permission_code',
    );
    const expected = Object.entries(ROLE_PERMISSIONS)
      .flatMap(([role, perms]) =>
        perms.map((permission) => ({ role_code: role, permission_code: permission })),
      )
      .sort(
        (a, b) =>
          a.role_code.localeCompare(b.role_code) ||
          a.permission_code.localeCompare(b.permission_code),
      );
    expect(mapping).toEqual(expected);
  });

  it('rejects granting a platform permission to a clinic role (CHECK constraint)', async () => {
    await expect(
      h.db.execute(
        `INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES ('CLINIC_OWNER', 'CLINIC', 'platform.users.view', 'PLATFORM')`,
      ),
    ).rejects.toThrow(/ck_role_permissions_scope|Check constraint/i);
  });

  it('rejects storing a clinic role as a global role', async () => {
    const user = await createUser(h.db);
    await expect(
      h.db.execute(
        `INSERT INTO user_global_roles (user_id, role_code, role_scope) VALUES (?, 'DOCTOR', 'CLINIC')`,
        [user.id],
      ),
    ).rejects.toThrow();
    await expect(
      h.db.execute(
        `INSERT INTO user_global_roles (user_id, role_code, role_scope) VALUES (?, 'DOCTOR', 'PATIENT')`,
        [user.id],
      ),
    ).rejects.toThrow();
  });

  it('rejects a platform role as a clinic membership', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    await expect(
      h.db.execute(
        `INSERT INTO clinic_memberships (clinic_id, user_id, role_code) VALUES (?, ?, 'SUPER_ADMIN')`,
        [clinic, user.id],
      ),
    ).rejects.toThrow();
  });

  it('makes it impossible to assign a branch of clinic B to a membership of clinic A', async () => {
    const user = await createUser(h.db);
    const clinicA = await createClinic(h.db);
    const clinicB = await createClinic(h.db);
    const branchB = await createBranch(h.db, clinicB);
    const membershipA = await addMembership(h.db, {
      clinicId: clinicA,
      userId: user.id,
      role: 'DOCTOR',
      branchScope: 'ASSIGNED',
    });
    // Claiming clinic A for the row: the branch FK (clinic_id, branch_id) fails.
    await expect(
      h.db.execute(
        'INSERT INTO clinic_membership_branches (membership_id, clinic_id, branch_id) VALUES (?, ?, ?)',
        [membershipA, clinicA, branchB],
      ),
    ).rejects.toThrow(/foreign key/i);
    // Claiming clinic B for the row: the membership FK (membership_id, clinic_id) fails.
    await expect(
      h.db.execute(
        'INSERT INTO clinic_membership_branches (membership_id, clinic_id, branch_id) VALUES (?, ?, ?)',
        [membershipA, clinicB, branchB],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('enforces E.164 phone numbers and one account per phone', async () => {
    await expect(
      h.db.execute(`INSERT INTO users (phone_e164) VALUES ('07701234567')`),
    ).rejects.toThrow();
    const user = await createUser(h.db);
    await expect(
      h.db.execute('INSERT INTO users (phone_e164) VALUES (?)', [user.phone]),
    ).rejects.toThrow(/Duplicate/);
  });

  it('rejects invalid status values and inverted effective windows', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    await expect(
      h.db.execute(`UPDATE users SET status = 'DELETED' WHERE id = ?`, [user.id]),
    ).rejects.toThrow();
    await expect(
      addMembership(h.db, {
        clinicId: clinic,
        userId: user.id,
        role: 'DOCTOR',
        effectiveFrom: new Date('2026-02-01'),
        effectiveUntil: new Date('2026-01-01'),
      }),
    ).rejects.toThrow();
  });
});
