import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { createUser, login, testDevice, type LoggedIn } from '../support/fixtures.js';
import { enrollMfa } from '../support/mfa.js';
import { adminSession, as, code, data, userSession } from '../support/platform.js';

/**
 * Task 03.1: `platform.specialties.manage` (catalog) and `platform.doctors.verify` (review) are
 * independent. Two test-only PLATFORM roles each hold exactly one of them, so "a user with only
 * X" is tested literally. The roles are removed in afterAll so the catalog/DB sync test is
 * unaffected.
 */
const h = createHarness();

const CURATOR = 'TEST_SPECIALTY_CURATOR';
const REVIEWER = 'TEST_DOCTOR_REVIEWER';

beforeAll(async () => {
  await h.db.execute(
    `INSERT INTO roles (code, scope, description) VALUES (?, 'PLATFORM', 'test only'), (?, 'PLATFORM', 'test only')`,
    [CURATOR, REVIEWER],
  );
  await h.db.execute(
    `INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES
       (?, 'PLATFORM', 'platform.specialties.manage', 'PLATFORM'),
       (?, 'PLATFORM', 'platform.doctors.verify', 'PLATFORM')`,
    [CURATOR, REVIEWER],
  );
});

afterAll(async () => {
  await h.db.execute(`DELETE FROM user_global_roles WHERE role_code IN (?, ?)`, [
    CURATOR,
    REVIEWER,
  ]);
  await h.db.execute(`DELETE FROM role_permissions WHERE role_code IN (?, ?)`, [CURATOR, REVIEWER]);
  await h.db.execute(`DELETE FROM roles WHERE code IN (?, ?)`, [CURATOR, REVIEWER]);
  await h.close();
});

async function platformSession(role: string): Promise<LoggedIn> {
  const user = await createUser(h.db);
  await h.db.execute(
    `INSERT INTO user_global_roles (user_id, role_code, role_scope) VALUES (?, ?, 'PLATFORM')`,
    [user.id, role],
  );
  const s = await login(h, user.phone, { device: testDevice('ADMIN_WEB') });
  await enrollMfa(h, s);
  return s;
}

const activeCodes = async (s: LoggedIn) =>
  data<{ code: string }[]>(await as(h, s).get('/specialties')).map((x) => x.code);

const catalog = async () =>
  h.db.query<{ code: string; name: string; active: number }>(
    'SELECT code, name, active FROM specialties ORDER BY code',
  );

async function pendingDoctorProfile(): Promise<string> {
  const doctor = await userSession(h);
  const created = await as(h, doctor).post('/me/doctor-profile', {
    displayName: 'Dr. Synthetic Example',
    specialties: [{ code: 'cardiology', primary: true }],
    licenseNumber: 'LIC-0001',
    licenseAuthority: 'Test Medical Council',
    licenseCountry: 'US',
    licenseExpiresOn: '2030-12-31',
  });
  expect(created.status).toBe(201);
  expect(
    (await as(h, doctor).upload('/me/doctor-profile/documents', 'MEDICAL_LICENSE')).status,
  ).toBe(201);
  expect((await as(h, doctor).post('/me/doctor-profile/verification')).status).toBe(200);
  return data<{ id: string }>(created).id;
}

const decide = (s: LoggedIn, id: string, decision: string) =>
  as(h, s).post(`/admin/doctor-profiles/${id}/verification`, { decision, reason: 'test' });

let admin: LoggedIn;
let curator: LoggedIn;
let reviewer: LoggedIn;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  curator = await platformSession(CURATOR);
  reviewer = await platformSession(REVIEWER);
  expect(
    (await as(h, admin).put('/admin/specialties/cardiology', { name: 'Cardiology' })).status,
  ).toBe(204);
});

describe('specialty catalog vs doctor verification permissions', () => {
  it('the migration seeds platform.specialties.manage and grants it to SUPER_ADMIN only', async () => {
    expect(
      await h.db.query(
        `SELECT code, scope FROM permissions WHERE code = 'platform.specialties.manage'`,
      ),
    ).toEqual([{ code: 'platform.specialties.manage', scope: 'PLATFORM' }]);
    const grants = await h.db.query<{ role_code: string }>(
      `SELECT role_code FROM role_permissions WHERE permission_code = 'platform.specialties.manage' AND role_code NOT IN (?, ?)`,
      [CURATOR, REVIEWER],
    );
    expect(grants.map((g) => g.role_code)).toEqual(['SUPER_ADMIN']);
  });

  it('SUPER_ADMIN holds both: manages the catalog and verifies doctors', async () => {
    expect(
      (await as(h, admin).put('/admin/specialties/pediatrics', { name: 'Pediatrics' })).status,
    ).toBe(204);
    const id = await pendingDoctorProfile();
    expect((await decide(admin, id, 'APPROVE')).status).toBe(200);
  });

  it('a holder of only platform.specialties.manage can create, rename and deactivate specialties', async () => {
    expect(
      (await as(h, curator).put('/admin/specialties/pediatrics', { name: 'Pediatrics' })).status,
    ).toBe(204);
    expect(
      (await as(h, curator).put('/admin/specialties/pediatrics', { name: 'Paediatrics' })).status,
    ).toBe(204);
    expect(
      (
        await as(h, curator).put('/admin/specialties/cardiology', {
          name: 'Cardiology',
          active: false,
        })
      ).status,
    ).toBe(204);
    expect(await catalog()).toEqual([
      { code: 'cardiology', name: 'Cardiology', active: 0 },
      { code: 'pediatrics', name: 'Paediatrics', active: 1 },
    ]);
    expect(await activeCodes(curator)).toEqual(['pediatrics']);
  });

  it('a holder of only platform.specialties.manage cannot review, verify, reject or suspend doctors', async () => {
    const id = await pendingDoctorProfile();
    expect(code(await as(h, curator).get('/admin/doctor-profiles'))).toBe('FORBIDDEN');
    expect(code(await as(h, curator).get(`/admin/doctor-profiles/${id}`))).toBe('FORBIDDEN');
    for (const decision of ['APPROVE', 'REJECT', 'SUSPEND']) {
      const res = await decide(curator, id, decision);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    }
    // Still pending; then suspend a verified profile — also denied.
    expect((await decide(admin, id, 'APPROVE')).status).toBe(200);
    expect(code(await decide(curator, id, 'SUSPEND'))).toBe('FORBIDDEN');
    const [row] = await h.db.query<{ verification_status: string }>(
      'SELECT verification_status FROM doctor_profiles WHERE id = ?',
      [id],
    );
    expect(row?.verification_status).toBe('VERIFIED');
  });

  it('a holder of only platform.doctors.verify cannot create, update or deactivate specialties', async () => {
    const before = await catalog();
    for (const payload of [
      ['pediatrics', { name: 'Pediatrics' }],
      ['cardiology', { name: 'Renamed' }],
      ['cardiology', { name: 'Cardiology', active: false }],
    ] as const) {
      const res = await as(h, reviewer).put(`/admin/specialties/${payload[0]}`, payload[1]);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FORBIDDEN');
    }
    expect(await catalog()).toEqual(before);
    expect(
      await h.db.query(
        `SELECT id FROM audit_events WHERE action = 'SPECIALTY_CHANGED' AND actor_user_id = ?`,
        [reviewer.userId],
      ),
    ).toEqual([]);
  });

  it('a holder of only platform.doctors.verify can still review and decide', async () => {
    const id = await pendingDoctorProfile();
    expect((await as(h, reviewer).get('/admin/doctor-profiles')).status).toBe(200);
    expect((await decide(reviewer, id, 'APPROVE')).status).toBe(200);
    expect((await decide(reviewer, id, 'SUSPEND')).status).toBe(200);
    expect((await decide(reviewer, id, 'REINSTATE')).status).toBe(200);
  });
});
