import type { AppConfig } from '../../../config/env.js';
import type { Database, SqlExecutor } from '../../../infrastructure/database/database.js';
import { AppError, NotFoundError } from '../../../shared/errors/app-error.js';
import type { RequestMeta } from '../../../shared/http/request-meta.js';
import type { Clock } from '../../../shared/security/clock.js';
import { randomToken, sha256Hex } from '../../../shared/security/crypto.js';
import { SECURITY_EVENT, type SecurityEventLog } from '../../audit/index.js';
import type { AccountStatus } from '../users.repository.js';

export const APP_TYPES = [
  'ADMIN_WEB',
  'CLINIC_WEB',
  'PATIENT_WEB',
  'PATIENT_MOBILE',
  'STAFF_MOBILE',
] as const;
export type AppType = (typeof APP_TYPES)[number];

export interface DeviceInfo {
  readonly deviceId: string;
  readonly appType: AppType;
  readonly deviceName?: string | undefined;
  readonly osName?: string | undefined;
  readonly osVersion?: string | undefined;
  readonly appVersion?: string | undefined;
}

export type RevocationReason =
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'USER_REVOKED'
  | 'USER_REVOKED_OTHERS'
  | 'REPLACED_BY_NEW_LOGIN'
  | 'REFRESH_TOKEN_REUSE'
  | 'ACCOUNT_SUSPENDED'
  | 'MFA_ENROLLED'
  | 'ACCOUNT_NOT_ACTIVE';

export interface CreatedSession {
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionExpiresAt: Date;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly appType: AppType;
  readonly activeClinicId: string | null;
  readonly mfaVerifiedAt: Date | null;
  readonly lastActivityAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly accountStatus: AccountStatus;
}

export interface SessionView {
  readonly id: string;
  readonly deviceId: string;
  readonly appType: AppType;
  readonly deviceName: string | null;
  readonly osName: string | null;
  readonly osVersion: string | null;
  readonly appVersion: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly expiresAt: Date;
  readonly current: boolean;
}

interface RefreshLookupRow {
  token_id: string;
  token_status: 'ACTIVE' | 'ROTATED' | 'REVOKED';
  token_expires_at: Date;
  session_id: string;
  user_id: string;
  session_expires_at: Date;
  session_revoked_at: Date | null;
  account_status: AccountStatus;
}

export interface RefreshResult {
  readonly userId: string;
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

/** Don't write last_activity_at on every request; this granularity is enough for session lists. */
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

export class SessionInvalidError extends AppError {
  constructor(message = 'Session is no longer valid. Please sign in again.') {
    super(401, 'SESSION_INVALID', message);
  }
}

export interface SessionServiceDeps {
  readonly db: Database;
  readonly securityEvents: SecurityEventLog;
  readonly config: Pick<AppConfig['auth'], 'refreshTokenTtlSeconds' | 'sessionMaxLifetimeSeconds'>;
  readonly clock: Clock;
}

/**
 * Sessions and refresh tokens.
 *
 * Refresh tokens are 256-bit random values; only their SHA-256 hash is stored (they are
 * high-entropy, so a keyed/slow hash adds nothing). Every refresh rotates the token. Presenting
 * an already-rotated token is treated as theft: the whole session (token family) is revoked.
 */
export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /** Creates a session + first refresh token inside the caller's (login) transaction. */
  async create(
    tx: SqlExecutor,
    userId: string,
    device: DeviceInfo,
    meta: RequestMeta,
  ): Promise<CreatedSession> {
    const now = this.deps.clock();
    // One live session per (user, device, app): logging in again on the same device replaces it.
    await this.revokeWhere(
      tx,
      'user_id = ? AND device_id = ? AND app_type = ?',
      [userId, device.deviceId, device.appType],
      'REPLACED_BY_NEW_LOGIN',
      now,
    );

    const sessionExpiresAt = new Date(
      now.getTime() + this.deps.config.sessionMaxLifetimeSeconds * 1000,
    );
    const result = await tx.execute(
      `INSERT INTO sessions
         (user_id, device_id, app_type, device_name, os_name, os_version, app_version,
          ip_address, user_agent, last_activity_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        device.deviceId,
        device.appType,
        device.deviceName ?? null,
        device.osName ?? null,
        device.osVersion ?? null,
        device.appVersion ?? null,
        meta.ip,
        meta.userAgent,
        now,
        sessionExpiresAt,
        now,
      ],
    );
    const sessionId = String(result.insertId);
    const { token, expiresAt } = await this.insertRefreshToken(
      tx,
      sessionId,
      sessionExpiresAt,
      now,
    );
    return { sessionId, refreshToken: token, refreshTokenExpiresAt: expiresAt, sessionExpiresAt };
  }

  /** Rotates a refresh token. Throws SessionInvalidError for every failure (uniform response). */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<RefreshResult> {
    const tokenHash = sha256Hex(refreshToken);
    const { db, securityEvents } = this.deps;

    const outcome = await db.transaction(async (tx) => {
      const now = this.deps.clock();
      const rows = await tx.query<RefreshLookupRow>(
        `SELECT rt.id AS token_id, rt.status AS token_status, rt.expires_at AS token_expires_at,
                s.id AS session_id, s.user_id, s.expires_at AS session_expires_at,
                s.revoked_at AS session_revoked_at, u.status AS account_status
           FROM refresh_tokens rt
           JOIN sessions s ON s.id = rt.session_id
           JOIN users u ON u.id = s.user_id
          WHERE rt.token_hash = ?
          FOR UPDATE`,
        [tokenHash],
      );
      const row = rows[0];
      if (row === undefined) return { ok: false as const, reason: 'UNKNOWN_TOKEN' };

      const base = { userId: row.user_id, sessionId: row.session_id };
      if (row.token_status === 'ROTATED') {
        // Reuse of a rotated token: someone holds a stolen copy. Kill the whole family.
        await this.revokeWhere(tx, 'id = ?', [row.session_id], 'REFRESH_TOKEN_REUSE', now);
        await securityEvents.record(
          tx,
          { type: SECURITY_EVENT.REFRESH_TOKEN_REUSE_DETECTED, outcome: 'FAILURE', ...base },
          meta,
        );
        return { ok: false as const, reason: 'REUSE_DETECTED', ...base };
      }
      const failure =
        row.token_status === 'REVOKED' || row.session_revoked_at !== null
          ? 'REVOKED'
          : row.token_expires_at <= now || row.session_expires_at <= now
            ? 'EXPIRED'
            : row.account_status !== 'ACTIVE'
              ? 'ACCOUNT_NOT_ACTIVE'
              : undefined;
      if (failure !== undefined) {
        if (failure === 'ACCOUNT_NOT_ACTIVE') {
          await this.revokeWhere(tx, 'id = ?', [row.session_id], 'ACCOUNT_NOT_ACTIVE', now);
        }
        await securityEvents.record(
          tx,
          {
            type: SECURITY_EVENT.TOKEN_REFRESH_FAILED,
            outcome: 'FAILURE',
            ...base,
            metadata: { reason: failure },
          },
          meta,
        );
        return { ok: false as const, reason: failure, ...base };
      }

      const next = await this.insertRefreshToken(tx, row.session_id, row.session_expires_at, now);
      await tx.execute(
        `UPDATE refresh_tokens SET status = 'ROTATED', used_at = ?, replaced_by_id = ? WHERE id = ?`,
        [now, next.id, row.token_id],
      );
      await tx.execute('UPDATE sessions SET last_activity_at = ? WHERE id = ?', [
        now,
        row.session_id,
      ]);
      await securityEvents.record(
        tx,
        { type: SECURITY_EVENT.TOKEN_REFRESHED, outcome: 'SUCCESS', ...base },
        meta,
      );
      return { ok: true as const, ...base, token: next.token, expiresAt: next.expiresAt };
    });

    if (!outcome.ok) throw new SessionInvalidError();
    return {
      userId: outcome.userId,
      sessionId: outcome.sessionId,
      refreshToken: outcome.token,
      refreshTokenExpiresAt: outcome.expiresAt,
    };
  }

  /** Loads the session + account status for an authenticated request. */
  async loadForRequest(sessionId: string): Promise<AuthenticatedSession | undefined> {
    const rows = await this.deps.db.query<{
      id: string;
      user_id: string;
      app_type: AppType;
      active_clinic_id: string | null;
      mfa_verified_at: Date | null;
      last_activity_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      account_status: AccountStatus;
    }>(
      `SELECT s.id, s.user_id, s.app_type, s.active_clinic_id, s.mfa_verified_at, s.last_activity_at,
              s.expires_at, s.revoked_at, u.status AS account_status
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      [sessionId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      sessionId: row.id,
      userId: row.user_id,
      appType: row.app_type,
      activeClinicId: row.active_clinic_id,
      mfaVerifiedAt: row.mfa_verified_at,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      accountStatus: row.account_status,
    };
  }

  async touch(session: AuthenticatedSession): Promise<void> {
    const now = this.deps.clock();
    if (now.getTime() - session.lastActivityAt.getTime() < ACTIVITY_WRITE_INTERVAL_MS) return;
    await this.deps.db.execute(
      'UPDATE sessions SET last_activity_at = ? WHERE id = ? AND revoked_at IS NULL',
      [now, session.sessionId],
    );
  }

  async listActive(userId: string, currentSessionId: string): Promise<SessionView[]> {
    const rows = await this.deps.db.query<{
      id: string;
      device_id: string;
      app_type: AppType;
      device_name: string | null;
      os_name: string | null;
      os_version: string | null;
      app_version: string | null;
      ip_address: string | null;
      user_agent: string | null;
      created_at: Date;
      last_activity_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, device_id, app_type, device_name, os_name, os_version, app_version, ip_address,
              user_agent, created_at, last_activity_at, expires_at
         FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY last_activity_at DESC`,
      [userId, this.deps.clock()],
    );
    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      appType: row.app_type,
      deviceName: row.device_name,
      osName: row.os_name,
      osVersion: row.os_version,
      appVersion: row.app_version,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      expiresAt: row.expires_at,
      current: row.id === currentSessionId,
    }));
  }

  /** Revokes one of the user's own sessions. A foreign session id is reported as not found. */
  async revokeOwn(
    userId: string,
    sessionId: string,
    actingSessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const count = await this.revokeWhere(
        tx,
        'id = ? AND user_id = ?',
        [sessionId, userId],
        sessionId === actingSessionId ? 'LOGOUT' : 'USER_REVOKED',
        this.deps.clock(),
      );
      if (count === 0) throw new NotFoundError('Session not found');
      await this.deps.securityEvents.record(
        tx,
        {
          type: SECURITY_EVENT.SESSION_REVOKED,
          outcome: 'SUCCESS',
          userId,
          sessionId: actingSessionId,
          metadata: { revokedSessionId: sessionId },
        },
        meta,
      );
    });
  }

  async logout(userId: string, sessionId: string, meta: RequestMeta): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await this.revokeWhere(
        tx,
        'id = ? AND user_id = ?',
        [sessionId, userId],
        'LOGOUT',
        this.deps.clock(),
      );
      await this.deps.securityEvents.record(
        tx,
        { type: SECURITY_EVENT.LOGOUT, outcome: 'SUCCESS', userId, sessionId },
        meta,
      );
    });
  }

  /** Revokes every session of the user, optionally keeping one (e.g. "sign out other devices"). */
  async revokeAllForUser(
    executor: SqlExecutor,
    userId: string,
    reason: RevocationReason,
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
    return options.exceptSessionId === undefined
      ? this.revokeWhere(executor, 'user_id = ?', [userId], reason, this.deps.clock())
      : this.revokeWhere(
          executor,
          'user_id = ? AND id <> ?',
          [userId, options.exceptSessionId],
          reason,
          this.deps.clock(),
        );
  }

  async logoutAll(userId: string, sessionId: string, meta: RequestMeta): Promise<number> {
    return this.deps.db.transaction(async (tx) => {
      const count = await this.revokeAllForUser(tx, userId, 'LOGOUT_ALL');
      await this.deps.securityEvents.record(
        tx,
        {
          type: SECURITY_EVENT.LOGOUT_ALL,
          outcome: 'SUCCESS',
          userId,
          sessionId,
          metadata: { count },
        },
        meta,
      );
      return count;
    });
  }

  async revokeOthers(userId: string, sessionId: string, meta: RequestMeta): Promise<number> {
    return this.deps.db.transaction(async (tx) => {
      const count = await this.revokeAllForUser(tx, userId, 'USER_REVOKED_OTHERS', {
        exceptSessionId: sessionId,
      });
      await this.deps.securityEvents.record(
        tx,
        {
          type: SECURITY_EVENT.OTHER_SESSIONS_REVOKED,
          outcome: 'SUCCESS',
          userId,
          sessionId,
          metadata: { count },
        },
        meta,
      );
      return count;
    });
  }

  async setActiveClinic(sessionId: string, clinicId: string | null): Promise<void> {
    await this.deps.db.execute('UPDATE sessions SET active_clinic_id = ? WHERE id = ?', [
      clinicId,
      sessionId,
    ]);
  }

  async markMfaVerified(executor: SqlExecutor, sessionId: string): Promise<void> {
    await executor.execute('UPDATE sessions SET mfa_verified_at = ? WHERE id = ?', [
      this.deps.clock(),
      sessionId,
    ]);
  }

  /**
   * Revokes matching live sessions and all their active refresh tokens. `where` is a fixed SQL
   * fragment from this class (never user input); values are bound parameters.
   */
  private async revokeWhere(
    executor: SqlExecutor,
    where: string,
    params: readonly (string | Date)[],
    reason: RevocationReason,
    now: Date,
  ): Promise<number> {
    await executor.execute(
      `UPDATE refresh_tokens SET status = 'REVOKED'
        WHERE status = 'ACTIVE'
          AND session_id IN (SELECT id FROM (SELECT id FROM sessions WHERE ${where} AND revoked_at IS NULL) AS s)`,
      params,
    );
    const result = await executor.execute(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE ${where} AND revoked_at IS NULL`,
      [now, reason, ...params],
    );
    return result.affectedRows;
  }

  private async insertRefreshToken(
    tx: SqlExecutor,
    sessionId: string,
    sessionExpiresAt: Date,
    now: Date,
  ): Promise<{ id: string; token: string; expiresAt: Date }> {
    const token = randomToken(32);
    const expiresAt = new Date(
      Math.min(
        now.getTime() + this.deps.config.refreshTokenTtlSeconds * 1000,
        sessionExpiresAt.getTime(),
      ),
    );
    const result = await tx.execute(
      'INSERT INTO refresh_tokens (session_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [sessionId, sha256Hex(token), expiresAt, now],
    );
    return { id: String(result.insertId), token, expiresAt };
  }
}
