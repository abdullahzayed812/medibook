import { randomInt } from 'node:crypto';
import type { AppConfig } from '../../../config/env.js';
import type { Database, SqlExecutor } from '../../../infrastructure/database/database.js';
import { ServiceUnavailableError, TooManyRequestsError } from '../../../shared/errors/app-error.js';
import type { RequestMeta } from '../../../shared/http/request-meta.js';
import type { Logger } from '../../../shared/logger/logger.js';
import type { Clock } from '../../../shared/security/clock.js';
import {
  deriveKey,
  hexDigestsEqual,
  hmacSha256Hex,
  randomHex,
} from '../../../shared/security/crypto.js';
import type { RateLimiter } from '../../../shared/security/rate-limiter.js';
import { SECURITY_EVENT, type SecurityEventLog } from '../../audit/index.js';
import { maskPhone } from '../phone.js';
import type { OtpProvider } from './otp-provider.js';

export interface OtpChallengeIssued {
  readonly challengeId: string;
  readonly expiresAt: Date;
  readonly resendAvailableAt: Date;
}

export type OtpVerificationFailure =
  'NOT_FOUND' | 'PHONE_MISMATCH' | 'ALREADY_USED' | 'EXPIRED' | 'INVALID_CODE' | 'LOCKED';

/** LOGIN signs in (and may create an account); GUEST_BOOKING only proves control of a phone. */
export type OtpPurpose = 'LOGIN' | 'GUEST_BOOKING' | 'PHONE_CHANGE';

export type OtpVerificationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: OtpVerificationFailure };

interface ChallengeRow {
  id: string;
  phone_e164: string;
  purpose: string;
  code_hash: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  expires_at: Date;
}

export interface OtpServiceDeps {
  readonly db: Database;
  readonly provider: OtpProvider;
  readonly rateLimiter: RateLimiter;
  readonly securityEvents: SecurityEventLog;
  readonly config: AppConfig['otp'];
  readonly authSecret: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * OTP challenges for phone login.
 *
 * - 6-digit codes from a CSPRNG; only HMAC-SHA256(key, challengeId:code) is stored.
 * - Rate limits: per IP and per phone (hourly) plus a per-phone resend cooldown.
 * - A new request supersedes earlier pending challenges for the same phone.
 * - Verification is attempt-limited per challenge; the attempt counter is incremented under a
 *   row lock, so parallel guesses cannot exceed the limit.
 * - Responses never depend on whether an account exists for the phone.
 */
export class OtpService {
  private readonly codeKey: Buffer;
  private readonly subjectKey: Buffer;

  constructor(private readonly deps: OtpServiceDeps) {
    this.codeKey = deriveKey(deps.authSecret, 'otp-code');
    this.subjectKey = deriveKey(deps.authSecret, 'subject-hash');
  }

  /** Keyed hash of a phone number: correlates events/limits without storing the number again. */
  subjectHash(phoneE164: string): string {
    return hmacSha256Hex(this.subjectKey, phoneE164);
  }

  async request(
    phoneE164: string,
    meta: RequestMeta,
    purpose: OtpPurpose = 'LOGIN',
  ): Promise<OtpChallengeIssued> {
    const { config, rateLimiter, db, securityEvents } = this.deps;
    const subject = this.subjectHash(phoneE164);

    const limits = [
      ...(meta.ip === null
        ? []
        : [
            () =>
              rateLimiter.consume(`otp:req:ip:${meta.ip}`, config.maxRequestsPerIpPerHour, 3600),
          ]),
      () => rateLimiter.acquireCooldown(`otp:req:phone:${subject}`, config.resendCooldownSeconds),
      () =>
        rateLimiter.consume(`otp:req:phone:${subject}`, config.maxRequestsPerPhonePerHour, 3600),
    ];
    for (const limit of limits) {
      const result = await limit();
      if (!result.allowed) {
        await securityEvents.record(
          db,
          {
            type: SECURITY_EVENT.OTP_REQUEST_RATE_LIMITED,
            outcome: 'FAILURE',
            subjectHash: subject,
          },
          meta,
        );
        throw new TooManyRequestsError(
          result.retryAfterSeconds,
          'Too many code requests. Please wait before trying again.',
          'OTP_RATE_LIMITED',
        );
      }
    }

    const now = this.deps.clock();
    const challengeId = randomHex(16);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + config.ttlSeconds * 1000);

    // READ COMMITTED: the superseding UPDATE takes no gap locks, so concurrent requests for
    // different phones no longer deadlock on the following INSERT (found in Task 05; it failed
    // most parallel requests at REPEATABLE READ). Deadlock victims are retried.
    await db.transactionWithRetry(
      async (tx) => {
        await tx.execute(
          `UPDATE otp_challenges SET status = 'SUPERSEDED' WHERE phone_e164 = ? AND purpose = ? AND status = 'PENDING'`,
          [phoneE164, purpose],
        );
        await tx.execute(
          `INSERT INTO otp_challenges
           (id, phone_e164, purpose, code_hash, max_attempts, expires_at, request_ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            challengeId,
            phoneE164,
            purpose,
            this.hashCode(challengeId, code),
            config.maxAttempts,
            expiresAt,
            meta.ip,
            now,
          ],
        );
        await securityEvents.record(
          tx,
          { type: SECURITY_EVENT.OTP_REQUESTED, outcome: 'INFO', subjectHash: subject },
          meta,
        );
      },
      { isolation: 'READ COMMITTED' },
    );

    try {
      await this.deps.provider.send({ phoneE164, code, purpose, expiresAt });
    } catch (err) {
      this.deps.logger.error(
        { err, provider: this.deps.provider.name, phone: maskPhone(phoneE164) },
        'OTP delivery failed',
      );
      await db.execute(`UPDATE otp_challenges SET status = 'SUPERSEDED' WHERE id = ?`, [
        challengeId,
      ]);
      throw new ServiceUnavailableError(
        'OTP_DELIVERY_FAILED',
        'The verification code could not be sent. Please try again later.',
      );
    }

    return {
      challengeId,
      expiresAt,
      resendAvailableAt: new Date(now.getTime() + config.resendCooldownSeconds * 1000),
    };
  }

  /** Throttles verification attempts per IP across all challenges (anti-enumeration of challenges). */
  async assertVerificationRateLimit(meta: RequestMeta): Promise<void> {
    if (meta.ip === null) return;
    const result = await this.deps.rateLimiter.consume(
      `otp:verify:ip:${meta.ip}`,
      this.deps.config.maxVerificationsPerIpPer15Min,
      900,
    );
    if (!result.allowed) {
      await this.deps.securityEvents.record(
        this.deps.db,
        { type: SECURITY_EVENT.OTP_VERIFICATION_RATE_LIMITED, outcome: 'FAILURE' },
        meta,
      );
      throw new TooManyRequestsError(
        result.retryAfterSeconds,
        'Too many verification attempts. Please wait before trying again.',
        'OTP_RATE_LIMITED',
      );
    }
  }

  /**
   * Verifies a code inside the caller's transaction. Failed attempts are counted in the same
   * transaction, so the caller must COMMIT (not roll back) on a failed result.
   */
  async verify(
    tx: SqlExecutor,
    input: { challengeId: string; phoneE164: string; code: string; purpose?: OtpPurpose },
  ): Promise<OtpVerificationResult> {
    const now = this.deps.clock();
    const rows = await tx.query<ChallengeRow>(
      `SELECT id, phone_e164, purpose, code_hash, status, attempt_count, max_attempts, expires_at
         FROM otp_challenges WHERE id = ? FOR UPDATE`,
      [input.challengeId],
    );
    const challenge = rows[0];
    // A challenge of another purpose is indistinguishable from a missing one.
    if (challenge?.purpose !== (input.purpose ?? 'LOGIN'))
      return { ok: false, reason: 'NOT_FOUND' };
    if (challenge.phone_e164 !== input.phoneE164) return { ok: false, reason: 'PHONE_MISMATCH' };
    if (challenge.status === 'LOCKED') return { ok: false, reason: 'LOCKED' };
    if (challenge.status !== 'PENDING') return { ok: false, reason: 'ALREADY_USED' };
    if (challenge.expires_at.getTime() <= now.getTime()) {
      await tx.execute(`UPDATE otp_challenges SET status = 'EXPIRED' WHERE id = ?`, [challenge.id]);
      return { ok: false, reason: 'EXPIRED' };
    }

    const attempts = challenge.attempt_count + 1;
    const matches =
      /^\d{6}$/.test(input.code) &&
      hexDigestsEqual(this.hashCode(challenge.id, input.code), challenge.code_hash);

    if (matches) {
      await tx.execute(
        `UPDATE otp_challenges SET status = 'VERIFIED', attempt_count = ?, verified_at = ? WHERE id = ?`,
        [attempts, now, challenge.id],
      );
      return { ok: true };
    }

    const locked = attempts >= challenge.max_attempts;
    await tx.execute('UPDATE otp_challenges SET attempt_count = ?, status = ? WHERE id = ?', [
      attempts,
      locked ? 'LOCKED' : 'PENDING',
      challenge.id,
    ]);
    return { ok: false, reason: locked ? 'LOCKED' : 'INVALID_CODE' };
  }

  private hashCode(challengeId: string, code: string): string {
    return hmacSha256Hex(this.codeKey, `${challengeId}:${code}`);
  }
}
