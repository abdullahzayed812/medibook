import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../../config/env.js';
import type { Database } from '../../../infrastructure/database/database.js';
import { AppError, ConflictError, TooManyRequestsError } from '../../../shared/errors/app-error.js';
import type { RequestMeta } from '../../../shared/http/request-meta.js';
import { base32Encode } from '../../../shared/security/base32.js';
import type { Clock } from '../../../shared/security/clock.js';
import { decrypt, deriveKey, encrypt, hmacSha256Hex } from '../../../shared/security/crypto.js';
import type { RateLimiter } from '../../../shared/security/rate-limiter.js';
import { totpUri, verifyTotp } from '../../../shared/security/totp.js';
import {
  AUDIT_ACTION,
  SECURITY_EVENT,
  type AuditLog,
  type SecurityEventLog,
} from '../../audit/index.js';
import type { SessionService } from '../sessions/sessions.service.js';

const RECOVERY_CODE_COUNT = 10;
const TOTP_SECRET_BYTES = 20; // 160 bits, the RFC 4226 recommendation

export interface MfaStatus {
  readonly enrolled: boolean;
  readonly pendingEnrollment: boolean;
  readonly remainingRecoveryCodes: number;
}

export interface EnrollmentStarted {
  /** Shown once so the user can add it to an authenticator app. Never logged or stored in plaintext. */
  readonly secret: string;
  readonly otpauthUri: string;
}

export type MfaProof = { readonly code: string } | { readonly recoveryCode: string };

interface CredentialRow {
  id: string;
  secret_ciphertext: Buffer;
  status: 'PENDING' | 'ACTIVE';
  last_used_step: string | null;
}

export class MfaCodeInvalidError extends AppError {
  constructor() {
    super(400, 'MFA_CODE_INVALID', 'The authentication code is invalid');
  }
}

export interface MfaServiceDeps {
  readonly db: Database;
  readonly sessions: SessionService;
  readonly securityEvents: SecurityEventLog;
  readonly auditLog: AuditLog;
  readonly rateLimiter: RateLimiter;
  readonly config: AppConfig['mfa'];
  readonly authSecret: string;
  readonly clock: Clock;
}

/**
 * TOTP second factor (mandatory for SUPER_ADMIN, enforced by the authorization service).
 *
 * - The TOTP secret is encrypted at rest with AES-256-GCM (key from MFA_ENCRYPTION_KEY, AAD bound
 *   to the user id so ciphertexts cannot be swapped between users).
 * - A code's time step must be strictly greater than the last accepted step (no replay).
 * - Recovery codes are single-use and stored as HMAC-SHA256 hashes.
 * - Verification attempts are rate limited per user.
 * - MFA state is attached to the session (`mfa_verified_at`), not to the access token.
 */
export class MfaService {
  private readonly recoveryKey: Buffer;

  constructor(private readonly deps: MfaServiceDeps) {
    this.recoveryKey = deriveKey(deps.authSecret, 'mfa-recovery-code');
  }

  async status(userId: string): Promise<MfaStatus> {
    const rows = await this.deps.db.query<{ status: string }>(
      'SELECT status FROM mfa_totp_credentials WHERE user_id = ?',
      [userId],
    );
    const codes = await this.deps.db.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL',
      [userId],
    );
    return {
      enrolled: rows[0]?.status === 'ACTIVE',
      pendingEnrollment: rows[0]?.status === 'PENDING',
      remainingRecoveryCodes: Number(codes[0]?.n ?? 0),
    };
  }

  async startEnrollment(
    userId: string,
    sessionId: string,
    accountLabel: string,
    meta: RequestMeta,
  ): Promise<EnrollmentStarted> {
    const secret = randomBytes(TOTP_SECRET_BYTES);
    const ciphertext = encrypt(this.deps.config.encryptionKey, secret, this.aad(userId));

    await this.deps.db.transaction(async (tx) => {
      const existing = await tx.query<{ status: string }>(
        'SELECT status FROM mfa_totp_credentials WHERE user_id = ? FOR UPDATE',
        [userId],
      );
      if (existing[0]?.status === 'ACTIVE') {
        throw new ConflictError('Two-factor authentication is already enabled');
      }
      await tx.execute(
        `INSERT INTO mfa_totp_credentials (user_id, secret_ciphertext, status) VALUES (?, ?, 'PENDING') AS new
         ON DUPLICATE KEY UPDATE secret_ciphertext = new.secret_ciphertext, last_used_step = NULL`,
        [userId, ciphertext],
      );
      await this.deps.securityEvents.record(
        tx,
        { type: SECURITY_EVENT.MFA_ENROLLMENT_STARTED, outcome: 'INFO', userId, sessionId },
        meta,
      );
    });

    const secretBase32 = base32Encode(secret);
    return {
      secret: secretBase32,
      otpauthUri: totpUri({
        issuer: this.deps.config.totpIssuer,
        account: accountLabel,
        secretBase32,
      }),
    };
  }

  /**
   * Activates a pending credential after the first valid code. Returns the recovery codes
   * (plaintext, exactly once). Other sessions are revoked: enabling 2FA is a sensitive change.
   */
  async confirmEnrollment(
    userId: string,
    sessionId: string,
    code: string,
    meta: RequestMeta,
  ): Promise<{ recoveryCodes: string[] }> {
    await this.assertRateLimit(userId);
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.newRecoveryCode());

    const result = await this.deps.db.transaction(async (tx) => {
      const rows = await tx.query<CredentialRow>(
        `SELECT id, secret_ciphertext, status, last_used_step FROM mfa_totp_credentials
          WHERE user_id = ? FOR UPDATE`,
        [userId],
      );
      const credential = rows[0];
      if (credential?.status !== 'PENDING') {
        throw new ConflictError('No pending two-factor enrollment');
      }
      const step = verifyTotp(this.decryptSecret(userId, credential), code, this.deps.clock());
      if (step === undefined) return { ok: false as const };

      await tx.execute(
        `UPDATE mfa_totp_credentials SET status = 'ACTIVE', activated_at = ?, last_used_step = ? WHERE id = ?`,
        [this.deps.clock(), step, credential.id],
      );
      await tx.execute('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [userId]);
      for (const recoveryCode of recoveryCodes) {
        await tx.execute('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)', [
          userId,
          this.hashRecoveryCode(recoveryCode),
        ]);
      }
      await this.deps.sessions.markMfaVerified(tx, sessionId);
      await this.deps.sessions.revokeAllForUser(tx, userId, 'MFA_ENROLLED', {
        exceptSessionId: sessionId,
      });
      await this.deps.securityEvents.record(
        tx,
        { type: SECURITY_EVENT.MFA_ENROLLED, outcome: 'SUCCESS', userId, sessionId },
        meta,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MFA_ENROLLED,
          actorUserId: userId,
          targetType: 'USER',
          targetId: userId,
          metadata: { method: 'TOTP' },
        },
        meta,
      );
      return { ok: true as const };
    });

    if (!result.ok) {
      await this.recordFailure(userId, sessionId, 'ENROLLMENT_CODE_INVALID', meta);
      throw new MfaCodeInvalidError();
    }
    return { recoveryCodes };
  }

  /** Step-up: marks the current session as MFA-verified using a TOTP code or a recovery code. */
  async verify(
    userId: string,
    sessionId: string,
    proof: MfaProof,
    meta: RequestMeta,
  ): Promise<void> {
    await this.assertRateLimit(userId);
    const ok = await this.deps.db.transaction(async (tx) => {
      const rows = await tx.query<CredentialRow>(
        `SELECT id, secret_ciphertext, status, last_used_step FROM mfa_totp_credentials
          WHERE user_id = ? FOR UPDATE`,
        [userId],
      );
      const credential = rows[0];
      if (credential?.status !== 'ACTIVE') {
        throw new AppError(409, 'MFA_NOT_ENROLLED', 'Two-factor authentication is not enabled');
      }

      if ('code' in proof) {
        const step = verifyTotp(
          this.decryptSecret(userId, credential),
          proof.code,
          this.deps.clock(),
        );
        const lastStep =
          credential.last_used_step === null ? -1 : Number(credential.last_used_step);
        if (step === undefined || step <= lastStep) return false;
        await tx.execute('UPDATE mfa_totp_credentials SET last_used_step = ? WHERE id = ?', [
          step,
          credential.id,
        ]);
        await this.deps.securityEvents.record(
          tx,
          {
            type: SECURITY_EVENT.MFA_VERIFICATION_SUCCEEDED,
            outcome: 'SUCCESS',
            userId,
            sessionId,
          },
          meta,
        );
      } else {
        const used = await tx.execute(
          `UPDATE mfa_recovery_codes SET used_at = ?
            WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
          [this.deps.clock(), userId, this.hashRecoveryCode(proof.recoveryCode)],
        );
        if (used.affectedRows !== 1) return false;
        await this.deps.securityEvents.record(
          tx,
          { type: SECURITY_EVENT.MFA_RECOVERY_CODE_USED, outcome: 'SUCCESS', userId, sessionId },
          meta,
        );
      }
      await this.deps.sessions.markMfaVerified(tx, sessionId);
      return true;
    });

    if (!ok) {
      await this.recordFailure(userId, sessionId, 'CODE_INVALID', meta);
      throw new MfaCodeInvalidError();
    }
  }

  /** Requires an MFA-verified session (enforced by the route). Invalidates all previous codes. */
  async regenerateRecoveryCodes(
    userId: string,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.newRecoveryCode());
    await this.deps.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [userId]);
      for (const recoveryCode of recoveryCodes) {
        await tx.execute('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)', [
          userId,
          this.hashRecoveryCode(recoveryCode),
        ]);
      }
      await this.deps.securityEvents.record(
        tx,
        {
          type: SECURITY_EVENT.MFA_RECOVERY_CODES_REGENERATED,
          outcome: 'SUCCESS',
          userId,
          sessionId,
        },
        meta,
      );
    });
    return { recoveryCodes };
  }

  private async assertRateLimit(userId: string): Promise<void> {
    const result = await this.deps.rateLimiter.consume(
      `mfa:verify:user:${userId}`,
      this.deps.config.maxVerificationsPer15Min,
      900,
    );
    if (!result.allowed) {
      throw new TooManyRequestsError(
        result.retryAfterSeconds,
        'Too many two-factor attempts. Please wait before trying again.',
        'MFA_RATE_LIMITED',
      );
    }
  }

  private async recordFailure(
    userId: string,
    sessionId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.securityEvents.record(
      this.deps.db,
      {
        type: SECURITY_EVENT.MFA_VERIFICATION_FAILED,
        outcome: 'FAILURE',
        userId,
        sessionId,
        metadata: { reason },
      },
      meta,
    );
  }

  private decryptSecret(userId: string, credential: CredentialRow): Buffer {
    return decrypt(this.deps.config.encryptionKey, credential.secret_ciphertext, this.aad(userId));
  }

  private aad(userId: string): string {
    return `mfa-totp:${userId}`;
  }

  /** 10 base32 characters (50 bits), formatted XXXXX-XXXXX. */
  private newRecoveryCode(): string {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  }

  private hashRecoveryCode(code: string): string {
    return hmacSha256Hex(this.recoveryKey, code.toUpperCase().replace(/[\s-]/g, ''));
  }
}
