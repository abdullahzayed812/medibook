import type { Database, SqlExecutor } from '../../../infrastructure/database/database.js';
import { AppError, ForbiddenError, NotFoundError } from '../../../shared/errors/app-error.js';
import type { RequestMeta } from '../../../shared/http/request-meta.js';
import type { Clock } from '../../../shared/security/clock.js';
import { defineStateMachine } from '../../../shared/state-machine.js';
import { AUDIT_ACTION, type AuditLog } from '../../audit/index.js';
import type { AuthorizationService, Principal } from '../authorization/authorization.service.js';
import { ASSIGNABLE_CLINIC_ROLES, type ClinicRole } from '../authorization/catalog.js';
import {
  membershipPeriod,
  type BranchScope,
  type MembershipsRepository,
  type MembershipStatus,
} from './memberships.repository.js';
import type { TenantContextResolver } from './tenant-context.js';

/** Membership lifecycle. INACTIVE = deactivated (reversible); TERMINATED = ended (re-hire possible). */
export const MEMBERSHIP_LIFECYCLE = defineStateMachine<MembershipStatus>('Membership', {
  PENDING: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'INACTIVE', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'INACTIVE', 'TERMINATED'],
  INACTIVE: ['ACTIVE', 'TERMINATED'],
  TERMINATED: ['ACTIVE'],
});

/**
 * Extension points filled by other modules (wired in the container):
 * - assertCanActivate: subscription capacity (e.g. max active members), checked when a
 *   membership becomes ACTIVE;
 * - outstandingResponsibilities: future modules (bookings, queue) report work that must be
 *   reassigned before a member stops being active. Non-empty → 409 with the list.
 */
export interface MembershipPolicyHooks {
  assertCanActivate(tx: SqlExecutor, clinicId: string, userId: string): Promise<void>;
  outstandingResponsibilities(
    tx: SqlExecutor,
    membership: { id: string; clinicId: string; userId: string; role: ClinicRole },
  ): Promise<string[]>;
}

export interface MembershipServiceDeps {
  readonly db: Database;
  readonly memberships: MembershipsRepository;
  readonly resolver: TenantContextResolver;
  readonly authz: AuthorizationService;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  readonly hooks?: MembershipPolicyHooks;
}

/**
 * Membership lifecycle (identity infrastructure; the clinic-management UI/API comes later).
 *
 * Privilege-escalation rules enforced here, for every change:
 *  1. nobody may change their own memberships;
 *  2. a clinic actor needs `clinic.memberships.manage` in THAT clinic and may only manage roles
 *     listed in ASSIGNABLE_CLINIC_ROLES for one of their roles there;
 *  3. CLINIC_OWNER memberships (and any role) can be managed with `platform.memberships.manage`
 *     (SUPER_ADMIN, MFA-verified).
 * Terminating/suspending affects only that membership: the account and other clinics are untouched,
 * and access ends on the next request because every request re-reads memberships.
 */
export class MembershipService {
  constructor(private readonly deps: MembershipServiceDeps) {}

  async grant(
    actor: Principal,
    input: {
      clinicId: string;
      userId: string;
      role: ClinicRole;
      branchScope: BranchScope;
      branchIds?: readonly string[];
      effectiveFrom?: Date | null;
      effectiveUntil?: Date | null;
    },
    meta: RequestMeta,
  ): Promise<string> {
    await this.authorizeChange(actor, input.clinicId, input.role, input.userId);
    const now = this.deps.clock();
    return this.deps.db.transaction(async (tx) => {
      await this.lockClinic(tx, input.clinicId);
      await this.deps.hooks?.assertCanActivate(tx, input.clinicId, input.userId);
      const membershipId = await this.deps.memberships.insert(tx, {
        clinicId: input.clinicId,
        userId: input.userId,
        role: input.role,
        branchScope: input.branchScope,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveUntil: input.effectiveUntil ?? null,
        createdBy: actor.userId,
        now,
      });
      await this.deps.memberships.replaceBranches(
        tx,
        input.clinicId,
        membershipId,
        input.branchScope,
        input.branchIds ?? [],
      );
      await this.deps.memberships.insertEvent(tx, {
        membershipId,
        clinicId: input.clinicId,
        fromStatus: null,
        toStatus: 'ACTIVE',
        actorUserId: actor.userId,
        reason: null,
      });
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MEMBERSHIP_CREATED,
          actorUserId: actor.userId,
          targetType: 'MEMBERSHIP',
          targetId: membershipId,
          clinicId: input.clinicId,
          metadata: { userId: input.userId, role: input.role, branchScope: input.branchScope },
        },
        meta,
      );
      return membershipId;
    });
  }

  async changeStatus(
    actor: Principal,
    input: { clinicId: string; membershipId: string; status: MembershipStatus; reason: string },
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await this.lockClinic(tx, input.clinicId);
      const membership = await this.lock(tx, input.clinicId, input.membershipId);
      await this.authorizeChange(actor, input.clinicId, membership.role, membership.userId);
      MEMBERSHIP_LIFECYCLE.assert(membership.status, input.status);
      if (input.status === 'ACTIVE') {
        await this.deps.hooks?.assertCanActivate(tx, input.clinicId, membership.userId);
      } else if (membership.status === 'ACTIVE') {
        if (membership.role === 'CLINIC_OWNER')
          await this.assertNotLastOwner(tx, input.clinicId, membership.id);
        const outstanding =
          (await this.deps.hooks?.outstandingResponsibilities(tx, {
            id: membership.id,
            clinicId: input.clinicId,
            userId: membership.userId,
            role: membership.role,
          })) ?? [];
        if (outstanding.length > 0) {
          throw new AppError(
            409,
            'OUTSTANDING_RESPONSIBILITIES',
            'Reassign outstanding work first',
            {
              details: { outstanding },
            },
          );
        }
      }
      const now = this.deps.clock();
      // Re-hire (TERMINATED → ACTIVE) starts a new, open-ended period: the ended period's
      // effective window must not carry over. Resuming (SUSPENDED/INACTIVE → ACTIVE) keeps it.
      const rehire = membership.status === 'TERMINATED' && input.status === 'ACTIVE';
      if (rehire) {
        await this.deps.memberships.reactivateAsNewPeriod(
          tx,
          input.clinicId,
          input.membershipId,
          { effectiveFrom: null, effectiveUntil: null },
          now,
        );
      } else {
        await this.deps.memberships.updateStatus(
          tx,
          input.clinicId,
          input.membershipId,
          input.status,
          now,
        );
      }
      await this.deps.memberships.insertEvent(tx, {
        membershipId: input.membershipId,
        clinicId: input.clinicId,
        fromStatus: membership.status,
        toStatus: input.status,
        actorUserId: actor.userId,
        reason: input.reason,
      });
      if (input.status !== 'ACTIVE') {
        await this.deps.memberships.clearActiveClinicIfNoAccess(
          tx,
          membership.userId,
          input.clinicId,
          now,
        );
      }
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MEMBERSHIP_STATUS_CHANGED,
          actorUserId: actor.userId,
          targetType: 'MEMBERSHIP',
          targetId: input.membershipId,
          clinicId: input.clinicId,
          metadata: {
            from: membership.status,
            to: input.status,
            reason: input.reason,
            ...(rehire ? { previousPeriod: membershipPeriod(membership) } : {}),
          },
        },
        meta,
      );
    });
  }

  async setBranches(
    actor: Principal,
    input: {
      clinicId: string;
      membershipId: string;
      branchScope: BranchScope;
      branchIds: readonly string[];
    },
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await this.lockClinic(tx, input.clinicId);
      const membership = await this.lock(tx, input.clinicId, input.membershipId);
      await this.authorizeChange(actor, input.clinicId, membership.role, membership.userId);
      await this.deps.memberships.replaceBranches(
        tx,
        input.clinicId,
        input.membershipId,
        input.branchScope,
        input.branchIds,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MEMBERSHIP_BRANCHES_CHANGED,
          actorUserId: actor.userId,
          targetType: 'MEMBERSHIP',
          targetId: input.membershipId,
          clinicId: input.clinicId,
          metadata: {
            fromScope: membership.branchScope,
            fromBranches: membership.branchIds,
            toScope: input.branchScope,
            toBranches: input.branchIds,
          },
        },
        meta,
      );
    });
  }

  /**
   * Serializes all membership changes of one clinic (prevents e.g. two owners removing each
   * other concurrently and leaving the clinic without an owner).
   */
  async lockClinic(tx: SqlExecutor, clinicId: string): Promise<void> {
    const rows = await tx.query<{ id: string }>('SELECT id FROM clinics WHERE id = ? FOR UPDATE', [
      clinicId,
    ]);
    if (rows.length === 0) throw new NotFoundError('Clinic not found');
  }

  /** A clinic must keep at least one ACTIVE owner; replacing one goes through ownership transfer. */
  async assertNotLastOwner(tx: SqlExecutor, clinicId: string, membershipId: string): Promise<void> {
    const others = await tx.query<{ id: string }>(
      `SELECT id FROM clinic_memberships
        WHERE clinic_id = ? AND role_code = 'CLINIC_OWNER' AND status = 'ACTIVE' AND id <> ?`,
      [clinicId, membershipId],
    );
    if (others.length === 0) {
      throw new AppError(
        409,
        'LAST_ACTIVE_OWNER',
        'The last active owner cannot be removed; use an ownership transfer instead',
      );
    }
  }

  private async lock(tx: SqlExecutor, clinicId: string, membershipId: string) {
    const membership = await this.deps.memberships.lockInClinic(tx, clinicId, membershipId);
    // A membership id of another clinic is indistinguishable from a missing one.
    if (membership === undefined) throw new NotFoundError('Membership not found');
    return membership;
  }

  async authorizeChange(
    actor: Principal,
    clinicId: string,
    targetRole: ClinicRole,
    targetUserId: string,
  ): Promise<void> {
    if (actor.userId === targetUserId) {
      throw new ForbiddenError('You cannot change your own memberships');
    }
    const platform = await this.deps.authz.check(actor, 'platform.memberships.manage');
    if (platform.allowed) return;

    const tenant = await this.deps.resolver.resolve(actor.userId, clinicId, null);
    await this.deps.authz.assert(actor, 'clinic.memberships.manage', { tenant });
    const assignable = tenant.memberships.some((m) =>
      ASSIGNABLE_CLINIC_ROLES[m.role].includes(targetRole),
    );
    if (!assignable) {
      throw new ForbiddenError(`Your role cannot manage ${targetRole} memberships`);
    }
  }
}
