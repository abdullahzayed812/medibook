import { randomUUID } from 'node:crypto';
import type { Database } from '../../../src/infrastructure/database/database.js';
import type { ClinicRole } from '../../../src/modules/access/index.js';
import { normalizePhone } from '../../../src/modules/iam/index.js';
import type { Harness } from './harness.js';

/**
 * Synthetic test data only. Phone numbers use the NANP fictional range 555-01xx.
 * Never use real patient information.
 */
let phoneCounter = 0;
export function testPhone(): string {
  phoneCounter = (phoneCounter + 1) % 100;
  return `+1202555${String(100 + phoneCounter).padStart(4, '0')}`;
}

export function testDevice(appType = 'CLINIC_WEB') {
  return {
    deviceId: `dev-${randomUUID()}`,
    appType,
    deviceName: 'Test Device',
    osName: 'TestOS',
    osVersion: '1.0',
    appVersion: '0.0.1',
  };
}

export async function createUser(
  db: Database,
  options: {
    phone?: string;
    status?: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' | 'PENDING_VERIFICATION';
  } = {},
): Promise<{ id: string; phone: string }> {
  const phone = options.phone ?? testPhone();
  const status = options.status ?? 'ACTIVE';
  const result = await db.execute(
    'INSERT INTO users (phone_e164, phone_verified_at, status) VALUES (?, ?, ?)',
    [phone, status === 'PENDING_VERIFICATION' ? null : new Date(), status],
  );
  const id = String(result.insertId);
  await db.execute('INSERT INTO user_profiles (user_id) VALUES (?)', [id]);
  return { id, phone };
}

/**
 * A test plan (unlimited, marketplace enabled) created once per database reset. Plans need a
 * creator, so a dedicated fixture account (outside the 555-01xx test range) is used.
 */
export async function ensureTestPlan(db: Database): Promise<{ planId: string; versionId: string }> {
  const existing = await db.query<{ id: string; current_version_id: string }>(
    `SELECT id, current_version_id FROM subscription_plans WHERE code = 'it_fixture_plan'`,
  );
  if (existing[0] !== undefined)
    return { planId: existing[0].id, versionId: existing[0].current_version_id };
  let creator = (
    await db.query<{ id: string }>(`SELECT id FROM users WHERE phone_e164 = '+12025559999'`)
  )[0]?.id;
  creator ??= (await createUser(db, { phone: '+12025559999' })).id;
  const planId = String(
    (
      await db.execute(
        `INSERT INTO subscription_plans (code, name) VALUES ('it_fixture_plan', 'Fixture plan')`,
      )
    ).insertId,
  );
  const versionId = String(
    (
      await db.execute(
        `INSERT INTO subscription_plan_versions (plan_id, version, monthly_price_minor, annual_price_minor, currency, trial_days, features, limits, created_by_user_id)
         VALUES (?, 1, 1000, 10000, 'USD', 0, ?, ?, ?)`,
        [
          planId,
          JSON.stringify({ marketplace_listing: true }),
          JSON.stringify({ max_branches: null, max_active_members: null }),
          creator,
        ],
      )
    ).insertId,
  );
  await db.execute('UPDATE subscription_plans SET current_version_id = ? WHERE id = ?', [
    versionId,
    planId,
  ]);
  return { planId, versionId };
}

/**
 * Operational clinic fixture: approved, ACTIVE, with an ACTIVE subscription (so the operation
 * gate allows new operations). Use `subscription: false` for a clinic without subscription.
 */
export async function createClinic(
  db: Database,
  name = `Test Clinic ${randomUUID().slice(0, 6)}`,
  options: { subscription?: boolean } = {},
): Promise<string> {
  const clinicId = String(
    (await db.execute('INSERT INTO clinics (name, approved_at) VALUES (?, ?)', [name, new Date()]))
      .insertId,
  );
  if (options.subscription !== false) {
    const { planId, versionId } = await ensureTestPlan(db);
    const now = new Date();
    await db.execute(
      `INSERT INTO clinic_subscriptions (clinic_id, plan_id, plan_version_id, status, billing_cycle, current_period_start, current_period_end, status_changed_at)
       VALUES (?, ?, ?, 'ACTIVE', 'ANNUAL', ?, ?, ?)`,
      [clinicId, planId, versionId, now, new Date(now.getTime() + 365 * 86_400_000), now],
    );
  }
  return clinicId;
}

export async function createBranch(
  db: Database,
  clinicId: string,
  name = 'Branch',
): Promise<string> {
  return String(
    (
      await db.execute('INSERT INTO clinic_branches (clinic_id, name) VALUES (?, ?)', [
        clinicId,
        name,
      ])
    ).insertId,
  );
}

/** Direct fixture insert (bypasses MembershipService authorization on purpose). */
export async function addMembership(
  db: Database,
  input: {
    clinicId: string;
    userId: string;
    role: ClinicRole;
    status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
    branchScope?: 'ALL' | 'ASSIGNED';
    branchIds?: string[];
    effectiveFrom?: Date | null;
    effectiveUntil?: Date | null;
  },
): Promise<string> {
  const id = String(
    (
      await db.execute(
        `INSERT INTO clinic_memberships (clinic_id, user_id, role_code, status, branch_scope, effective_from, effective_until, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.clinicId,
          input.userId,
          input.role,
          input.status ?? 'ACTIVE',
          input.branchScope ?? 'ALL',
          input.effectiveFrom ?? null,
          input.effectiveUntil ?? null,
          new Date(),
        ],
      )
    ).insertId,
  );
  for (const branchId of input.branchIds ?? []) {
    await db.execute(
      'INSERT INTO clinic_membership_branches (membership_id, clinic_id, branch_id) VALUES (?, ?, ?)',
      [id, input.clinicId, branchId],
    );
  }
  return id;
}

export async function grantGlobalRole(
  db: Database,
  userId: string,
  role: 'SUPER_ADMIN' | 'PATIENT',
): Promise<void> {
  await db.execute(
    'INSERT INTO user_global_roles (user_id, role_code, role_scope) VALUES (?, ?, ?)',
    [userId, role, role === 'SUPER_ADMIN' ? 'PLATFORM' : 'PATIENT'],
  );
}

export interface LoggedIn {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly bearer: string;
}

/** Full API login: request OTP → read it from the mock outbox → verify. */
export async function login(
  h: Harness,
  phone: string,
  options: { device?: ReturnType<typeof testDevice>; ip?: string } = {},
): Promise<LoggedIn> {
  const ip =
    options.ip ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  await h.clearCooldowns();
  const requested = await h
    .http()
    .post('/api/v1/auth/otp/request')
    .set('X-Forwarded-For', ip)
    .send({ phone });
  if (requested.status !== 202)
    throw new Error(`OTP request failed: ${requested.status} ${JSON.stringify(requested.body)}`);
  const { challengeId } = (requested.body as { data: { challengeId: string } }).data;
  const code = h.otp.lastCodeFor(normalizePhone(phone));
  const verified = await h
    .http()
    .post('/api/v1/auth/otp/verify')
    .set('X-Forwarded-For', ip)
    .send({ challengeId, phone, code, device: options.device ?? testDevice() });
  if (verified.status !== 200)
    throw new Error(`OTP verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  const data = (
    verified.body as {
      data: {
        accessToken: string;
        refreshToken: string;
        sessionId: string;
        account: { id: string };
      };
    }
  ).data;
  return { ...data, userId: data.account.id, bearer: `Bearer ${data.accessToken}` };
}

/** Typed access to Supertest bodies (shared helper from src/test-support). */
export { jsonBody as body } from '../../../src/test-support/http.js';
