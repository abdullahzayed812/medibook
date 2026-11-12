import type { Database } from '../../infrastructure/database/database.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import { SECURITY_EVENT, type SecurityEventLog } from '../audit/index.js';
import type { OtpService } from './otp/otp.service.js';
import type { DeviceInfo, SessionService } from './sessions/sessions.service.js';
import type { AccessTokenService } from './tokens/access-tokens.js';
import type { AccountStatus, UsersRepository } from './users.repository.js';

export interface LoginResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
  readonly account: {
    readonly id: string;
    readonly status: AccountStatus;
    readonly isNew: boolean;
  };
  /** True when the account holds a role that requires 2FA before privileged use (SUPER_ADMIN). */
  readonly mfaRequired: boolean;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

/** Roles whose holders must complete 2FA. Kept here (not in access) to avoid a module cycle. */
export const MFA_REQUIRED_GLOBAL_ROLES: readonly string[] = ['SUPER_ADMIN'];

export class OtpInvalidError extends AppError {
  constructor() {
    super(400, 'OTP_INVALID', 'The verification code is invalid or has expired');
  }
}

export class OtpAttemptsExceededError extends AppError {
  constructor() {
    super(400, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Please request a new code.');
  }
}

export interface AuthServiceDeps {
  readonly db: Database;
  readonly otp: OtpService;
  readonly sessions: SessionService;
  readonly tokens: AccessTokenService;
  readonly users: UsersRepository;
  readonly securityEvents: SecurityEventLog;
  readonly clock: Clock;
}

/**
 * Phone + OTP login ("sign in or sign up"). A verified OTP proves ownership of the phone, so the
 * account is created on first successful verification; the OTP request step never reveals
 * whether an account exists.
 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async loginWithOtp(
    input: { challengeId: string; phoneE164: string; code: string; device: DeviceInfo },
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const { db, otp, users, sessions, securityEvents } = this.deps;
    await otp.assertVerificationRateLimit(meta);
    const subjectHash = otp.subjectHash(input.phoneE164);

    // READ COMMITTED + bounded retry (found in Task 05): at REPEATABLE READ, concurrent first
    // logins of DIFFERENT users deadlocked on gap locks and failed with 500. Only locking reads
    // are used here, and a challenge is single-use, so the weaker isolation is safe; a retried
    // run starts clean because the rollback also restored the challenge.
    const outcome = await db.transactionWithRetry(
      async (tx) => {
        const verification = await otp.verify(tx, input);
        if (!verification.ok) {
          await securityEvents.record(
            tx,
            {
              type:
                verification.reason === 'LOCKED'
                  ? SECURITY_EVENT.OTP_LOCKED
                  : SECURITY_EVENT.OTP_VERIFICATION_FAILED,
              outcome: 'FAILURE',
              subjectHash,
              metadata: { reason: verification.reason },
            },
            meta,
          );
          return { kind: 'otp_failed' as const, reason: verification.reason };
        }

        let user = await users.findByPhoneForUpdate(tx, input.phoneE164);
        let isNew = false;
        if (user === undefined) {
          const userId = await users.createVerified(tx, input.phoneE164, this.deps.clock());
          user = await users.findById(tx, userId);
          isNew = true;
          await securityEvents.record(
            tx,
            { type: SECURITY_EVENT.ACCOUNT_CREATED, outcome: 'SUCCESS', userId, subjectHash },
            meta,
          );
        }
        if (user === undefined) throw new Error('User disappeared inside login transaction');

        await securityEvents.record(
          tx,
          {
            type: SECURITY_EVENT.OTP_VERIFICATION_SUCCEEDED,
            outcome: 'SUCCESS',
            userId: user.id,
            subjectHash,
          },
          meta,
        );

        if (user.status === 'SUSPENDED' || user.status === 'INACTIVE') {
          await securityEvents.record(
            tx,
            {
              type: SECURITY_EVENT.LOGIN_FAILED,
              outcome: 'FAILURE',
              userId: user.id,
              metadata: { reason: `ACCOUNT_${user.status}` },
            },
            meta,
          );
          return { kind: 'blocked' as const, status: user.status };
        }

        await users.markPhoneVerified(tx, user.id, this.deps.clock());
        const session = await sessions.create(tx, user.id, input.device, meta);
        await securityEvents.record(
          tx,
          {
            type: SECURITY_EVENT.LOGIN_SUCCEEDED,
            outcome: 'SUCCESS',
            userId: user.id,
            sessionId: session.sessionId,
            metadata: { appType: input.device.appType },
          },
          meta,
        );
        const roles = await users.listGlobalRoles(tx, user.id);
        return { kind: 'ok' as const, userId: user.id, isNew, session, roles };
      },
      { isolation: 'READ COMMITTED' },
    );

    switch (outcome.kind) {
      case 'otp_failed':
        throw outcome.reason === 'LOCKED' ? new OtpAttemptsExceededError() : new OtpInvalidError();
      case 'blocked':
        throw outcome.status === 'SUSPENDED'
          ? new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended')
          : new AppError(403, 'ACCOUNT_INACTIVE', 'This account is inactive');
      case 'ok': {
        const access = await this.deps.tokens.issue(outcome.userId, outcome.session.sessionId);
        return {
          accessToken: access.token,
          accessTokenExpiresAt: access.expiresAt,
          refreshToken: outcome.session.refreshToken,
          refreshTokenExpiresAt: outcome.session.refreshTokenExpiresAt,
          sessionId: outcome.session.sessionId,
          account: { id: outcome.userId, status: 'ACTIVE', isNew: outcome.isNew },
          mfaRequired: outcome.roles.some((role) => MFA_REQUIRED_GLOBAL_ROLES.includes(role)),
        };
      }
    }
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const rotated = await this.deps.sessions.refresh(refreshToken, meta);
    const access = await this.deps.tokens.issue(rotated.userId, rotated.sessionId);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: rotated.refreshToken,
      refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
    };
  }
}
