import type { SqlExecutor } from '../../infrastructure/database/database.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import { toPage, type Page } from '../../shared/http/pagination.js';

/**
 * Security event types. Adding a type is cheap; renaming one breaks searches over history,
 * so treat the strings as a stable contract.
 */
export const SECURITY_EVENT = {
  OTP_REQUESTED: 'OTP_REQUESTED',
  OTP_REQUEST_RATE_LIMITED: 'OTP_REQUEST_RATE_LIMITED',
  OTP_VERIFICATION_SUCCEEDED: 'OTP_VERIFICATION_SUCCEEDED',
  OTP_VERIFICATION_FAILED: 'OTP_VERIFICATION_FAILED',
  OTP_LOCKED: 'OTP_LOCKED',
  OTP_VERIFICATION_RATE_LIMITED: 'OTP_VERIFICATION_RATE_LIMITED',
  ACCOUNT_CREATED: 'ACCOUNT_CREATED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  TOKEN_REFRESH_FAILED: 'TOKEN_REFRESH_FAILED',
  REFRESH_TOKEN_REUSE_DETECTED: 'REFRESH_TOKEN_REUSE_DETECTED',
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  SESSION_REVOKED: 'SESSION_REVOKED',
  OTHER_SESSIONS_REVOKED: 'OTHER_SESSIONS_REVOKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_REACTIVATED: 'ACCOUNT_REACTIVATED',
  CLINIC_CONTEXT_SWITCHED: 'CLINIC_CONTEXT_SWITCHED',
  MFA_ENROLLMENT_STARTED: 'MFA_ENROLLMENT_STARTED',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_VERIFICATION_SUCCEEDED: 'MFA_VERIFICATION_SUCCEEDED',
  MFA_VERIFICATION_FAILED: 'MFA_VERIFICATION_FAILED',
  MFA_RECOVERY_CODE_USED: 'MFA_RECOVERY_CODE_USED',
  MFA_RECOVERY_CODES_REGENERATED: 'MFA_RECOVERY_CODES_REGENERATED',
  // Task 05.2.1: refused privileged identity operations (the refused transaction rolls back)
  IDENTITY_OPERATION_REFUSED: 'IDENTITY_OPERATION_REFUSED',
} as const;

export type SecurityEventType = (typeof SECURITY_EVENT)[keyof typeof SECURITY_EVENT];
export type SecurityEventOutcome = 'SUCCESS' | 'FAILURE' | 'INFO';

export interface SecurityEventInput {
  readonly type: SecurityEventType;
  readonly outcome: SecurityEventOutcome;
  readonly userId?: string | null;
  readonly sessionId?: string | null;
  /** Keyed hash of the subject (e.g. phone) for events about not-yet-identified users. */
  readonly subjectHash?: string | null;
  /** Small, non-sensitive facts (reasons, counts). NEVER codes, tokens, secrets or medical data. */
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SecurityEventView {
  readonly id: string;
  readonly type: string;
  readonly outcome: string;
  readonly sessionId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
}

interface SecurityEventRow {
  id: string;
  event_type: string;
  outcome: string;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: unknown;
  created_at: Date;
}

/**
 * Append-only writer. Accepts any executor so events commit atomically with the change they
 * describe (pass the transaction), or independently (pass the database).
 */
export class SecurityEventLog {
  async record(executor: SqlExecutor, event: SecurityEventInput, meta: RequestMeta): Promise<void> {
    await executor.execute(
      `INSERT INTO security_events
         (event_type, outcome, user_id, session_id, subject_hash, ip_address, user_agent, request_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.type,
        event.outcome,
        event.userId ?? null,
        event.sessionId ?? null,
        event.subjectHash ?? null,
        meta.ip,
        meta.userAgent,
        meta.requestId,
        event.metadata === undefined ? null : JSON.stringify(event.metadata),
      ],
    );
  }

  async listForUser(
    executor: SqlExecutor,
    userId: string,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<Page<SecurityEventView>> {
    const rows = await executor.query<SecurityEventRow>(
      `SELECT id, event_type, outcome, session_id, ip_address, user_agent, metadata, created_at
         FROM security_events
        WHERE user_id = ? AND (? IS NULL OR id < ?)
        ORDER BY id DESC
        LIMIT ?`,
      [userId, page.cursor ?? null, page.cursor ?? null, page.limit + 1],
    );
    return toPage(
      rows.map((row) => ({
        id: row.id,
        type: row.event_type,
        outcome: row.outcome,
        sessionId: row.session_id,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        metadata: row.metadata,
        createdAt: row.created_at,
      })),
      page.limit,
    );
  }
}
