import type { SqlExecutor } from '../../infrastructure/database/database.js';

export const ACCOUNT_STATUSES = [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'INACTIVE',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface User {
  readonly id: string;
  readonly phoneE164: string;
  readonly phoneVerifiedAt: Date | null;
  readonly email: string | null;
  readonly status: AccountStatus;
  readonly createdAt: Date;
}

export interface UserProfile {
  readonly displayName: string | null;
  readonly preferredLocale: string | null;
}

export interface DoctorProfile {
  readonly id: string;
  readonly displayName: string;
  readonly licenseNumber: string | null;
}

interface UserRow {
  id: string;
  phone_e164: string;
  phone_verified_at: Date | null;
  email: string | null;
  status: AccountStatus;
  created_at: Date;
}

const USER_COLUMNS = 'id, phone_e164, phone_verified_at, email, status, created_at';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    phoneE164: row.phone_e164,
    phoneVerifiedAt: row.phone_verified_at,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** Raw SQL for users, user_profiles, doctor_profiles and user_global_roles (global identity). */
export class UsersRepository {
  async findById(executor: SqlExecutor, userId: string): Promise<User | undefined> {
    const rows = await executor.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [
      userId,
    ]);
    return rows[0] === undefined ? undefined : toUser(rows[0]);
  }

  /** Locks the row (inside a transaction) so concurrent logins cannot create duplicates. */
  async findByPhoneForUpdate(executor: SqlExecutor, phoneE164: string): Promise<User | undefined> {
    const rows = await executor.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE phone_e164 = ? FOR UPDATE`,
      [phoneE164],
    );
    return rows[0] === undefined ? undefined : toUser(rows[0]);
  }

  async lockById(executor: SqlExecutor, userId: string): Promise<User | undefined> {
    const rows = await executor.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    return rows[0] === undefined ? undefined : toUser(rows[0]);
  }

  /** Creates an account whose phone was just proven by OTP (status ACTIVE). */
  async createVerified(executor: SqlExecutor, phoneE164: string, now: Date): Promise<string> {
    const result = await executor.execute(
      `INSERT INTO users (phone_e164, phone_verified_at, status, status_changed_at) VALUES (?, ?, 'ACTIVE', ?)`,
      [phoneE164, now, now],
    );
    const userId = String(result.insertId);
    await executor.execute('INSERT INTO user_profiles (user_id) VALUES (?)', [userId]);
    return userId;
  }

  /** Account created by someone else (e.g. a future clinic invitation); not yet verified. */
  async createPendingVerification(executor: SqlExecutor, phoneE164: string): Promise<string> {
    const result = await executor.execute('INSERT INTO users (phone_e164) VALUES (?)', [phoneE164]);
    const userId = String(result.insertId);
    await executor.execute('INSERT INTO user_profiles (user_id) VALUES (?)', [userId]);
    return userId;
  }

  async markPhoneVerified(executor: SqlExecutor, userId: string, now: Date): Promise<void> {
    await executor.execute(
      `UPDATE users
          SET phone_verified_at = COALESCE(phone_verified_at, ?),
              status = IF(status = 'PENDING_VERIFICATION', 'ACTIVE', status),
              status_changed_at = IF(status = 'PENDING_VERIFICATION', ?, status_changed_at)
        WHERE id = ?`,
      [now, now, userId],
    );
  }

  async setStatus(
    executor: SqlExecutor,
    userId: string,
    status: AccountStatus,
    now: Date,
  ): Promise<void> {
    await executor.execute('UPDATE users SET status = ?, status_changed_at = ? WHERE id = ?', [
      status,
      now,
      userId,
    ]);
  }

  async findProfile(executor: SqlExecutor, userId: string): Promise<UserProfile> {
    const rows = await executor.query<{
      display_name: string | null;
      preferred_locale: string | null;
    }>('SELECT display_name, preferred_locale FROM user_profiles WHERE user_id = ?', [userId]);
    return {
      displayName: rows[0]?.display_name ?? null,
      preferredLocale: rows[0]?.preferred_locale ?? null,
    };
  }

  async findDoctorProfile(executor: SqlExecutor, userId: string): Promise<DoctorProfile | null> {
    const rows = await executor.query<{
      id: string;
      display_name: string;
      license_number: string | null;
    }>('SELECT id, display_name, license_number FROM doctor_profiles WHERE user_id = ?', [userId]);
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, displayName: row.display_name, licenseNumber: row.license_number };
  }

  async listGlobalRoles(executor: SqlExecutor, userId: string): Promise<string[]> {
    const rows = await executor.query<{ role_code: string }>(
      'SELECT role_code FROM user_global_roles WHERE user_id = ? ORDER BY role_code',
      [userId],
    );
    return rows.map((row) => row.role_code);
  }
}
