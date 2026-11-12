import { z } from 'zod';
import { must } from '../../shared/must.js';
import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import { randomToken, sha256Hex } from '../../shared/security/crypto.js';
import {
  ASSIGNABLE_CLINIC_ROLES,
  isPeriodEnded,
  membershipPeriod,
  tenantExecutor,
  type AuthorizationService,
  type BranchScope,
  type ClinicRole,
  type MembershipService,
  type MembershipsRepository,
  type MembershipStatus,
  type Principal,
  type TenantContext,
  type TenantContextResolver,
} from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import { maskPhone } from '../iam/index.js';
import type { DomainEventOutbox, PlatformSettingsService } from '../platform/index.js';
import type { SubscriptionService } from '../subscriptions/index.js';

export const INVITABLE_ROLES = ['CLINIC_MANAGER', 'DOCTOR', 'RECEPTIONIST'] as const;

export const invitationCreateSchema = z
  .object({
    phone: z.string().min(1).max(32),
    role: z.enum(INVITABLE_ROLES),
    branchScope: z.enum(['ALL', 'ASSIGNED']),
    branchIds: z
      .array(z.string().regex(/^[1-9]\d{0,19}$/))
      .max(100)
      .default([]),
  })
  .strict();

export const branchAssignmentSchema = z
  .object({
    branchScope: z.enum(['ALL', 'ASSIGNED']),
    branchIds: z
      .array(z.string().regex(/^[1-9]\d{0,19}$/))
      .max(100)
      .default([]),
  })
  .strict();

interface InvitationRow {
  id: string;
  clinic_id: string;
  role_code: ClinicRole;
  branch_scope: BranchScope;
  invited_phone_e164: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED';
  expires_at: Date;
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  accepted_at: Date | null;
  membership_id: string | null;
  revoked_at: Date | null;
  created_at: Date;
  branch_ids?: string | null;
}

/** Invitation as shown to the clinic (phone masked, never the token or its hash). */
const toInvitation = (r: InvitationRow) => ({
  id: r.id,
  clinicId: r.clinic_id,
  role: r.role_code,
  branchScope: r.branch_scope,
  branchIds:
    r.branch_ids === null || r.branch_ids === undefined || r.branch_ids === ''
      ? []
      : r.branch_ids.split(','),
  invitedPhone: maskPhone(r.invited_phone_e164),
  status: r.status,
  expiresAt: r.expires_at,
  invitedByUserId: r.invited_by_user_id,
  acceptedByUserId: r.accepted_by_user_id,
  acceptedAt: r.accepted_at,
  membershipId: r.membership_id,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
});

export interface StaffDeps {
  readonly db: Database;
  readonly authz: AuthorizationService;
  readonly resolver: TenantContextResolver;
  readonly memberships: MembershipsRepository;
  readonly membershipService: MembershipService;
  readonly subscriptions: SubscriptionService;
  readonly settings: PlatformSettingsService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
  readonly clock: Clock;
}

const INVALID_INVITATION = () =>
  new AppError(404, 'INVITATION_INVALID', 'This invitation is invalid, expired or already used');

/**
 * Staff management for clinic actors. People join a clinic ONLY through invitations (consent of
 * the invitee, bound to their phone). Direct grants remain a platform-only path.
 */
export class StaffService {
  constructor(private readonly deps: StaffDeps) {}

  // ---------- members ----------

  async listMembers(
    actor: Principal,
    tenant: TenantContext,
    filter: { status?: MembershipStatus | undefined; limit: number; cursor?: string | undefined },
  ) {
    await this.deps.authz.assert(actor, 'clinic.memberships.view', { tenant });
    const rows = await tenantExecutor(this.deps.db, tenant.scope).query<{
      id: string;
      user_id: string;
      role_code: ClinicRole;
      status: MembershipStatus;
      branch_scope: BranchScope;
      public_listing: number;
      effective_from: Date | null;
      effective_until: Date | null;
      activated_at: Date | null;
      terminated_at: Date | null;
      phone_e164: string;
      display_name: string | null;
      branch_ids: string | null;
    }>(
      `SELECT m.id, m.user_id, m.role_code, m.status, m.branch_scope, m.public_listing, m.effective_from, m.effective_until,
              m.activated_at, m.terminated_at, u.phone_e164, p.display_name,
              (SELECT GROUP_CONCAT(b.branch_id ORDER BY b.branch_id) FROM clinic_membership_branches b WHERE b.membership_id = m.id) AS branch_ids
         FROM clinic_memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN user_profiles p ON p.user_id = m.user_id
        WHERE m.clinic_id = ? AND (? IS NULL OR m.status = ?) AND (? IS NULL OR m.id < ?)
        ORDER BY m.id DESC LIMIT ?`,
      [
        tenant.clinicId,
        filter.status ?? null,
        filter.status ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return toPage(
      rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        displayName: r.display_name,
        phone: maskPhone(r.phone_e164),
        role: r.role_code,
        status: r.status,
        branchScope: r.branch_scope,
        branchIds: r.branch_ids === null ? [] : r.branch_ids.split(','),
        publicListing: r.public_listing === 1,
        effectiveFrom: r.effective_from,
        effectiveUntil: r.effective_until,
        activatedAt: r.activated_at,
        terminatedAt: r.terminated_at,
      })),
      filter.limit,
    );
  }

  /** Delegates to the Task 02 MembershipService (escalation rules, last-owner guard, history, audit). */
  async changeStatus(
    actor: Principal,
    tenant: TenantContext,
    membershipId: string,
    status: MembershipStatus,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.membershipService.changeStatus(
      actor,
      { clinicId: tenant.clinicId, membershipId, status, reason },
      meta,
    );
  }

  async setBranches(
    actor: Principal,
    tenant: TenantContext,
    membershipId: string,
    input: { branchScope: BranchScope; branchIds: readonly string[] },
    meta: RequestMeta,
  ): Promise<void> {
    const branchIds = await this.validateBranches(
      this.deps.db,
      tenant.clinicId,
      input.branchScope,
      input.branchIds,
    );
    await this.deps.membershipService.setBranches(
      actor,
      { clinicId: tenant.clinicId, membershipId, branchScope: input.branchScope, branchIds },
      meta,
    );
  }

  async setDoctorPublicListing(
    actor: Principal,
    tenant: TenantContext,
    membershipId: string,
    listed: boolean,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'clinic.doctors.manage', { tenant });
    await this.deps.db.transaction(async (tx) => {
      const result = await tenantExecutor(tx, tenant.scope).execute(
        `UPDATE clinic_memberships SET public_listing = ? WHERE id = ? AND clinic_id = ? AND role_code = 'DOCTOR'`,
        [listed ? 1 : 0, membershipId, tenant.clinicId],
      );
      if (result.affectedRows !== 1) throw new NotFoundError('Doctor membership not found');
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MEMBERSHIP_PUBLIC_LISTING_CHANGED,
          actorUserId: actor.userId,
          targetType: 'MEMBERSHIP',
          targetId: membershipId,
          clinicId: tenant.clinicId,
          metadata: { publicListing: listed },
        },
        meta,
      );
    });
  }

  // ---------- invitations (clinic side) ----------

  async invite(
    actor: Principal,
    tenant: TenantContext,
    input: {
      phoneE164: string;
      role: (typeof INVITABLE_ROLES)[number];
      branchScope: BranchScope;
      branchIds: readonly string[];
    },
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'clinic.memberships.manage', { tenant });
    if (!tenant.memberships.some((m) => ASSIGNABLE_CLINIC_ROLES[m.role].includes(input.role))) {
      throw new ForbiddenError(`Your role cannot invite ${input.role} members`);
    }
    return this.deps.db.transaction(async (tx) => {
      await this.deps.membershipService.lockClinic(tx, tenant.clinicId);
      const self = await tx.query('SELECT id FROM users WHERE id = ? AND phone_e164 = ?', [
        actor.userId,
        input.phoneE164,
      ]);
      if (self.length > 0) throw new ForbiddenError('You cannot invite yourself');
      const branchIds = await this.validateBranches(
        tx,
        tenant.clinicId,
        input.branchScope,
        input.branchIds,
      );
      const active = await tx.query(
        `SELECT m.id FROM clinic_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.clinic_id = ? AND u.phone_e164 = ? AND m.role_code = ? AND m.status = 'ACTIVE'
            AND (m.effective_until IS NULL OR m.effective_until > ?)`,
        [tenant.clinicId, input.phoneE164, input.role, this.deps.clock()],
      );
      if (active.length > 0)
        throw new ConflictError('This person already holds that role in the clinic');
      await this.expireStale(tx, tenant.clinicId);
      const pending = await tx.query(
        `SELECT id FROM clinic_invitations WHERE clinic_id = ? AND invited_phone_e164 = ? AND role_code = ? AND status = 'PENDING'`,
        [tenant.clinicId, input.phoneE164, input.role],
      );
      if (pending.length > 0)
        throw new ConflictError('A pending invitation already exists; revoke it first');
      await this.deps.subscriptions.assertCanGrow(tx, tenant.clinicId, 'max_active_members');

      const token = randomToken(32);
      const ttlHours = await this.deps.settings.get('invitation.ttl_hours', tx);
      const expiresAt = new Date(this.deps.clock().getTime() + ttlHours * 3_600_000);
      const id = String(
        (
          await tx.execute(
            `INSERT INTO clinic_invitations (clinic_id, role_code, branch_scope, invited_phone_e164, token_hash, expires_at, invited_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              tenant.clinicId,
              input.role,
              input.branchScope,
              input.phoneE164,
              sha256Hex(token),
              expiresAt,
              actor.userId,
            ],
          )
        ).insertId,
      );
      for (const branchId of branchIds) {
        await tx.execute(
          'INSERT INTO clinic_invitation_branches (invitation_id, clinic_id, branch_id) VALUES (?, ?, ?)',
          [id, tenant.clinicId, branchId],
        );
      }
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.INVITATION_CREATED,
          actorUserId: actor.userId,
          targetType: 'INVITATION',
          targetId: id,
          clinicId: tenant.clinicId,
          metadata: { role: input.role, branchScope: input.branchScope, branchIds, expiresAt },
        },
        meta,
      );
      await this.deps.outbox.record(tx, {
        type: 'invitation.created',
        aggregateType: 'invitation',
        aggregateId: id,
        clinicId: tenant.clinicId,
        payload: { role: input.role },
      });
      // The token is returned ONCE to the inviter for delivery (notification integration is a later task).
      return {
        invitation: toInvitation(must(await this.findInvitation(tx, id), 'invitation')),
        token,
      };
    });
  }

  async listInvitations(actor: Principal, tenant: TenantContext, status?: InvitationRow['status']) {
    await this.deps.authz.assert(actor, 'clinic.memberships.view', { tenant });
    await this.expireStale(this.deps.db, tenant.clinicId);
    const rows = await tenantExecutor(this.deps.db, tenant.scope).query<InvitationRow>(
      `SELECT i.*, (SELECT GROUP_CONCAT(b.branch_id ORDER BY b.branch_id) FROM clinic_invitation_branches b WHERE b.invitation_id = i.id) AS branch_ids
         FROM clinic_invitations i WHERE i.clinic_id = ? AND (? IS NULL OR i.status = ?) ORDER BY i.id DESC LIMIT 200`,
      [tenant.clinicId, status ?? null, status ?? null],
    );
    return rows.map(toInvitation);
  }

  async revoke(
    actor: Principal,
    tenant: TenantContext,
    invitationId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'clinic.memberships.manage', { tenant });
    await this.deps.db.transaction(async (tx) => {
      const rows = await tenantExecutor(tx, tenant.scope).query<InvitationRow>(
        'SELECT * FROM clinic_invitations WHERE id = ? AND clinic_id = ? FOR UPDATE',
        [invitationId, tenant.clinicId],
      );
      const inv = rows[0];
      if (inv === undefined) throw new NotFoundError('Invitation not found');
      if (!tenant.memberships.some((m) => ASSIGNABLE_CLINIC_ROLES[m.role].includes(inv.role_code)))
        throw new ForbiddenError(`Your role cannot manage ${inv.role_code} invitations`);
      if (inv.status !== 'PENDING')
        throw new ConflictError(`A ${inv.status} invitation cannot be revoked`);
      await tx.execute(
        `UPDATE clinic_invitations SET status = 'REVOKED', revoked_by_user_id = ?, revoked_at = ? WHERE id = ?`,
        [actor.userId, this.deps.clock(), invitationId],
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.INVITATION_CHANGED,
          actorUserId: actor.userId,
          targetType: 'INVITATION',
          targetId: invitationId,
          clinicId: tenant.clinicId,
          metadata: { from: 'PENDING', to: 'REVOKED' },
        },
        meta,
      );
    });
  }

  /** Closing hook: pending invitations die when a clinic starts closing. */
  async revokePendingForClinic(
    tx: SqlExecutor,
    clinicId: string,
    actorUserId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const result = await tx.execute(
      `UPDATE clinic_invitations SET status = 'REVOKED', revoked_by_user_id = ?, revoked_at = ? WHERE clinic_id = ? AND status = 'PENDING'`,
      [actorUserId, this.deps.clock(), clinicId],
    );
    if (result.affectedRows > 0) {
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.INVITATION_CHANGED,
          actorUserId,
          targetType: 'CLINIC',
          targetId: clinicId,
          clinicId,
          metadata: { revokedPending: result.affectedRows, reason: 'Clinic closing' },
        },
        meta,
      );
    }
  }

  // ---------- invitations (invitee side) ----------

  async myInvitations(actor: Principal) {
    const rows = await this.deps.db.query<InvitationRow & { clinic_name: string }>(
      `SELECT i.*, c.name AS clinic_name FROM clinic_invitations i
         JOIN users u ON u.phone_e164 = i.invited_phone_e164 AND u.id = ?
         JOIN clinics c ON c.id = i.clinic_id
        WHERE i.status = 'PENDING' AND i.expires_at > ? ORDER BY i.id DESC`,
      [actor.userId, this.deps.clock()],
    );
    return rows.map((r) => ({
      id: r.id,
      clinicId: r.clinic_id,
      clinicName: r.clinic_name,
      role: r.role_code,
      expiresAt: r.expires_at,
    }));
  }

  /**
   * Accepts with the token. Every failure (unknown, used, revoked, expired, other phone) is the
   * same INVITATION_INVALID. All bindings come from the stored invitation, never the request.
   *
   * Lock order (ADR-034): clinic row first, then the invitation row, like every other clinic
   * mutation (closure approval revokes invitations under the clinic lock). The invitation is
   * therefore re-read and re-validated after both locks are held.
   */
  async accept(actor: Principal, token: string, meta: RequestMeta) {
    return this.deps.db.transaction(async (tx) => {
      const located = await tx.query<{ clinic_id: string }>(
        'SELECT clinic_id FROM clinic_invitations WHERE token_hash = ?',
        [sha256Hex(token)],
      );
      if (located[0] === undefined) throw INVALID_INVITATION();
      await this.deps.membershipService.lockClinic(tx, located[0].clinic_id);
      const inv = await this.lockByToken(tx, actor, token);
      const clinic = await tx.query<{ operational_status: string }>(
        'SELECT operational_status FROM clinics WHERE id = ?',
        [inv.clinic_id],
      );
      if (
        clinic[0]?.operational_status !== 'ACTIVE' &&
        clinic[0]?.operational_status !== 'SUSPENDED'
      )
        throw INVALID_INVITATION();
      // Re-validate the inviter's authority NOW (they may have been demoted since inviting).
      const inviterOk = await this.inviterStillAuthorized(inv);
      if (!inviterOk) throw INVALID_INVITATION();

      const now = this.deps.clock();
      const existing = await this.deps.memberships.listForUserInClinic(
        tx,
        inv.clinic_id,
        actor.userId,
        true,
      );
      const alreadyActiveMember = existing.some((m) => m.status === 'ACTIVE');
      const sameRole = existing.find((m) => m.role === inv.role_code);
      // An ACTIVE row whose effective window has ended no longer grants the role: renewable.
      if (sameRole?.status === 'ACTIVE' && !isPeriodEnded(sameRole, now))
        throw new ConflictError('You already hold this role in the clinic');
      if (!alreadyActiveMember)
        await this.deps.subscriptions.assertCanGrow(tx, inv.clinic_id, 'max_active_members');

      const branchIds = await tx.query<{ branch_id: string }>(
        'SELECT branch_id FROM clinic_invitation_branches WHERE invitation_id = ? AND clinic_id = ?',
        [inv.id, inv.clinic_id],
      );
      // Re-check the bound branches (composite FKs already pin them to this clinic).
      try {
        await this.validateBranches(
          tx,
          inv.clinic_id,
          inv.branch_scope,
          branchIds.map((b) => b.branch_id),
        );
      } catch {
        throw INVALID_INVITATION();
      }
      let membershipId: string;
      if (sameRole === undefined) {
        membershipId = await this.deps.memberships.insert(tx, {
          clinicId: inv.clinic_id,
          userId: actor.userId,
          role: inv.role_code,
          branchScope: inv.branch_scope,
          effectiveFrom: null,
          effectiveUntil: null,
          createdBy: inv.invited_by_user_id,
          now,
        });
      } else {
        // Same (clinic, user, role) row: start a NEW period (the invitation carries no dates, so
        // it is open-ended from now). The previous period is kept in the audit event below and
        // in clinic_membership_events.
        membershipId = sameRole.id;
        await this.deps.memberships.reactivateAsNewPeriod(
          tx,
          inv.clinic_id,
          sameRole.id,
          { effectiveFrom: null, effectiveUntil: null },
          now,
        );
      }
      await this.deps.memberships.replaceBranches(
        tx,
        inv.clinic_id,
        membershipId,
        inv.branch_scope,
        branchIds.map((b) => b.branch_id),
      );
      await this.deps.memberships.insertEvent(tx, {
        membershipId,
        clinicId: inv.clinic_id,
        fromStatus: sameRole?.status ?? null,
        toStatus: 'ACTIVE',
        actorUserId: actor.userId,
        reason:
          sameRole === undefined
            ? `Invitation ${inv.id} accepted`
            : `Invitation ${inv.id} accepted (new membership period)`,
      });
      await tx.execute(
        `UPDATE clinic_invitations SET status = 'ACCEPTED', accepted_by_user_id = ?, accepted_at = ?, membership_id = ? WHERE id = ?`,
        [actor.userId, now, membershipId, inv.id],
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.INVITATION_CHANGED,
          actorUserId: actor.userId,
          targetType: 'INVITATION',
          targetId: inv.id,
          clinicId: inv.clinic_id,
          metadata: { from: 'PENDING', to: 'ACCEPTED', membershipId },
        },
        meta,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MEMBERSHIP_CREATED,
          actorUserId: inv.invited_by_user_id,
          targetType: 'MEMBERSHIP',
          targetId: membershipId,
          clinicId: inv.clinic_id,
          metadata: {
            userId: actor.userId,
            role: inv.role_code,
            via: 'INVITATION',
            invitationId: inv.id,
            ...(sameRole === undefined
              ? {}
              : { reactivated: true, previousPeriod: membershipPeriod(sameRole) }),
          },
        },
        meta,
      );
      await this.deps.outbox.record(tx, {
        type: 'membership.activated',
        aggregateType: 'membership',
        aggregateId: membershipId,
        clinicId: inv.clinic_id,
        payload: { role: inv.role_code },
      });
      return { membershipId, clinicId: inv.clinic_id, role: inv.role_code };
    });
  }

  async decline(actor: Principal, token: string, meta: RequestMeta): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const inv = await this.lockByToken(tx, actor, token);
      await tx.execute(`UPDATE clinic_invitations SET status = 'DECLINED' WHERE id = ?`, [inv.id]);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.INVITATION_CHANGED,
          actorUserId: actor.userId,
          targetType: 'INVITATION',
          targetId: inv.id,
          clinicId: inv.clinic_id,
          metadata: { from: 'PENDING', to: 'DECLINED' },
        },
        meta,
      );
    });
  }

  // ---------- internals ----------

  private async lockByToken(
    tx: SqlExecutor,
    actor: Principal,
    token: string,
  ): Promise<InvitationRow> {
    const rows = await tx.query<InvitationRow>(
      'SELECT * FROM clinic_invitations WHERE token_hash = ? FOR UPDATE',
      [sha256Hex(token)],
    );
    const inv = rows[0];
    if (inv?.status !== 'PENDING') throw INVALID_INVITATION();
    const phone = await tx.query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM users WHERE id = ?',
      [actor.userId],
    );
    if (phone[0]?.phone_e164 !== inv.invited_phone_e164) throw INVALID_INVITATION();
    // Expiry is time-based: an expired invitation is rejected here and marked EXPIRED by the next
    // write on that clinic (expireStale) or listing. No write here: this row is locked by this tx.
    if (inv.expires_at <= this.deps.clock()) throw INVALID_INVITATION();
    return inv;
  }

  private async inviterStillAuthorized(inv: InvitationRow): Promise<boolean> {
    try {
      const tenant = await this.deps.resolver.resolve(inv.invited_by_user_id, inv.clinic_id, null);
      const decision = await this.deps.authz.check(
        { userId: inv.invited_by_user_id, mfaVerified: false },
        'clinic.memberships.manage',
        { tenant },
      );
      return (
        decision.allowed &&
        tenant.memberships.some((m) => ASSIGNABLE_CLINIC_ROLES[m.role].includes(inv.role_code))
      );
    } catch {
      return false;
    }
  }

  private async validateBranches(
    executor: SqlExecutor,
    clinicId: string,
    scope: BranchScope,
    branchIds: readonly string[],
  ): Promise<string[]> {
    const unique = [...new Set(branchIds)];
    if (scope === 'ALL') {
      if (unique.length > 0)
        throw new ValidationError([
          { location: 'body', path: 'branchIds', message: 'must be empty when branchScope is ALL' },
        ]);
      return [];
    }
    if (unique.length === 0)
      throw new ValidationError([
        { location: 'body', path: 'branchIds', message: 'at least one branch is required' },
      ]);
    const found = await executor.query<{ id: string }>(
      `SELECT id FROM clinic_branches WHERE clinic_id = ? AND id IN (${unique.map(() => '?').join(', ')})`,
      [clinicId, ...unique],
    );
    // Branch ids of another clinic are indistinguishable from unknown ids.
    if (found.length !== unique.length)
      throw new ValidationError([
        { location: 'body', path: 'branchIds', message: 'unknown branch' },
      ]);
    return unique;
  }

  private async expireStale(tx: SqlExecutor, clinicId: string): Promise<void> {
    await tx.execute(
      `UPDATE clinic_invitations SET status = 'EXPIRED' WHERE clinic_id = ? AND status = 'PENDING' AND expires_at <= ?`,
      [clinicId, this.deps.clock()],
    );
  }

  private async findInvitation(
    executor: SqlExecutor,
    id: string,
  ): Promise<InvitationRow | undefined> {
    const rows = await executor.query<InvitationRow>(
      `SELECT i.*, (SELECT GROUP_CONCAT(b.branch_id ORDER BY b.branch_id) FROM clinic_invitation_branches b WHERE b.invitation_id = i.id) AS branch_ids
         FROM clinic_invitations i WHERE i.id = ?`,
      [id],
    );
    return rows[0];
  }
}
