import type { Database } from '../../infrastructure/database/database.js';
import { AppError, UnauthorizedError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { OtpService } from './otp/otp.service.js';
import { maskPhone } from './phone.js';

/**
 * Verified account phone change (Task 05.1, ADR-051). The account proves control of BOTH the
 * current and the new phone with PHONE_CHANGE codes (they can never log in or verify a guest).
 * Identity is the account (user_id): booking persons, delegations, claimed guest persons and
 * clinic profiles stay attached to the account; nothing moves to or from any other person. The
 * old number becomes free; whoever registers it later starts with a NEW account and person and
 * inherits nothing. A user who lost the current phone goes through support (identity case).
 */
export class PhoneChangeService {
  constructor(private readonly deps: { db: Database; otp: OtpService; auditLog: AuditLog }) {}

  async request(userId: string, newPhoneE164: string, meta: RequestMeta) {
    const current = await this.currentPhone(userId);
    if (current === newPhoneE164)
      throw new AppError(400, 'PHONE_UNCHANGED', 'This is already your phone number');
    await this.assertAvailable(newPhoneE164);
    const currentChallenge = await this.deps.otp.request(current, meta, 'PHONE_CHANGE');
    const newChallenge = await this.deps.otp.request(newPhoneE164, meta, 'PHONE_CHANGE');
    return {
      currentChallengeId: currentChallenge.challengeId,
      newChallengeId: newChallenge.challengeId,
      expiresAt: newChallenge.expiresAt,
    };
  }

  async confirm(
    userId: string,
    input: {
      newPhoneE164: string;
      currentChallengeId: string;
      currentCode: string;
      newChallengeId: string;
      newCode: string;
    },
    meta: RequestMeta,
  ) {
    await this.deps.otp.assertVerificationRateLimit(meta);
    const current = await this.currentPhone(userId);
    const outcome = await this.deps.db.transactionWithRetry(
      async (tx) => {
        // Both codes are checked (attempts counted) before anything changes.
        const a = await this.deps.otp.verify(tx, {
          challengeId: input.currentChallengeId,
          phoneE164: current,
          code: input.currentCode,
          purpose: 'PHONE_CHANGE',
        });
        const b = await this.deps.otp.verify(tx, {
          challengeId: input.newChallengeId,
          phoneE164: input.newPhoneE164,
          code: input.newCode,
          purpose: 'PHONE_CHANGE',
        });
        if (!a.ok || !b.ok) return { ok: false as const };
        const taken = await tx.query(
          'SELECT id FROM users WHERE phone_e164 = ? AND id <> ? FOR UPDATE',
          [input.newPhoneE164, userId],
        );
        if (taken.length > 0) return { ok: false as const, taken: true };
        await tx.execute(
          'UPDATE users SET phone_e164 = ?, phone_verified_at = NOW(3) WHERE id = ?',
          [input.newPhoneE164, userId],
        );
        await this.deps.auditLog.record(
          tx,
          {
            action: AUDIT_ACTION.ACCOUNT_PHONE_CHANGED,
            actorUserId: userId,
            targetType: 'USER',
            targetId: userId,
            metadata: { from: maskPhone(current), to: maskPhone(input.newPhoneE164) },
          },
          meta,
        );
        return { ok: true as const };
      },
      { isolation: 'READ COMMITTED' },
    );
    if (!outcome.ok)
      throw 'taken' in outcome
        ? new AppError(409, 'PHONE_UNAVAILABLE', 'This phone number cannot be used')
        : new AppError(400, 'OTP_INVALID', 'The verification code is invalid or has expired');
    return { phone: maskPhone(input.newPhoneE164) };
  }

  private async currentPhone(userId: string): Promise<string> {
    const row = (
      await this.deps.db.query<{ phone_e164: string }>(
        'SELECT phone_e164 FROM users WHERE id = ?',
        [userId],
      )
    )[0];
    if (row === undefined) throw new UnauthorizedError();
    return row.phone_e164;
  }

  private async assertAvailable(phone: string): Promise<void> {
    const rows = await this.deps.db.query('SELECT id FROM users WHERE phone_e164 = ?', [phone]);
    if (rows.length > 0)
      throw new AppError(409, 'PHONE_UNAVAILABLE', 'This phone number cannot be used');
  }
}
