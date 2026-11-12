import type { Database } from '../../infrastructure/database/database.js';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import {
  AUDIT_ACTION,
  SECURITY_EVENT,
  type AuditLog,
  type SecurityEventLog,
} from '../audit/index.js';
import type { SessionService } from './sessions/sessions.service.js';
import type { DoctorProfile, User, UserProfile, UsersRepository } from './users.repository.js';

export interface AccountView {
  readonly user: User;
  readonly profile: UserProfile;
  readonly doctorProfile: DoctorProfile | null;
  readonly globalRoles: readonly string[];
}

export interface AccountServiceDeps {
  readonly db: Database;
  readonly users: UsersRepository;
  readonly sessions: SessionService;
  readonly securityEvents: SecurityEventLog;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
}

/**
 * Account lifecycle (foundation only). Callers must authorize the actor first
 * (e.g. platform.users.manage_status); this service enforces state rules and side effects.
 */
export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  async getAccount(userId: string): Promise<AccountView> {
    const { db, users } = this.deps;
    const user = await users.findById(db, userId);
    if (user === undefined) throw new NotFoundError('Account not found');
    return {
      user,
      profile: await users.findProfile(db, userId),
      doctorProfile: await users.findDoctorProfile(db, userId),
      globalRoles: await users.listGlobalRoles(db, userId),
    };
  }

  /** Suspends an account and revokes all of its sessions immediately. */
  async suspend(
    actorUserId: string,
    targetUserId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (actorUserId === targetUserId)
      throw new ForbiddenError('You cannot suspend your own account');
    await this.deps.db.transaction(async (tx) => {
      const user = await this.deps.users.lockById(tx, targetUserId);
      if (user === undefined) throw new NotFoundError('Account not found');
      if (user.status === 'SUSPENDED') {
        throw new AppError(409, 'ACCOUNT_ALREADY_SUSPENDED', 'Account is already suspended');
      }
      await this.deps.users.setStatus(tx, targetUserId, 'SUSPENDED', this.deps.clock());
      const revoked = await this.deps.sessions.revokeAllForUser(
        tx,
        targetUserId,
        'ACCOUNT_SUSPENDED',
      );
      await this.deps.securityEvents.record(
        tx,
        {
          type: SECURITY_EVENT.ACCOUNT_SUSPENDED,
          outcome: 'INFO',
          userId: targetUserId,
          metadata: { revokedSessions: revoked },
        },
        meta,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.ACCOUNT_SUSPENDED,
          actorUserId,
          targetType: 'USER',
          targetId: targetUserId,
          metadata: { fromStatus: user.status, reason },
        },
        meta,
      );
    });
  }

  /** Reactivates a suspended account: ACTIVE if the phone was verified, else PENDING_VERIFICATION. */
  async reactivate(
    actorUserId: string,
    targetUserId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const user = await this.deps.users.lockById(tx, targetUserId);
      if (user === undefined) throw new NotFoundError('Account not found');
      if (user.status !== 'SUSPENDED') {
        throw new AppError(
          409,
          'ACCOUNT_NOT_SUSPENDED',
          'Only suspended accounts can be reactivated',
        );
      }
      const next = user.phoneVerifiedAt === null ? 'PENDING_VERIFICATION' : 'ACTIVE';
      await this.deps.users.setStatus(tx, targetUserId, next, this.deps.clock());
      await this.deps.securityEvents.record(
        tx,
        { type: SECURITY_EVENT.ACCOUNT_REACTIVATED, outcome: 'INFO', userId: targetUserId },
        meta,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.ACCOUNT_REACTIVATED,
          actorUserId,
          targetType: 'USER',
          targetId: targetUserId,
          metadata: { toStatus: next, reason },
        },
        meta,
      );
    });
  }
}
