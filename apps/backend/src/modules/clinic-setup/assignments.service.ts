import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import { tenantExecutor, type Principal, type TenantContext } from '../access/index.js';
import { AUDIT_ACTION } from '../audit/index.js';
import {
  ASSIGNMENT_SELECT,
  assignmentBlockers,
  authorizeBranch,
  branchTenant,
  iso,
  loadAssignment,
  loadBranch,
  membershipUsable,
  recordChange,
  type AssignmentRow,
  type SetupDeps,
} from './context.js';

export type AssignmentStatus = 'ACTIVE' | 'INACTIVE';

export function toAssignmentView(r: AssignmentRow, now: Date) {
  const blockers = assignmentBlockers(r, now);
  return {
    id: r.id,
    branch: {
      id: r.branch_id,
      name: r.branch_name,
      timeZone: r.time_zone,
      status: r.branch_status,
    },
    membershipId: r.membership_id,
    doctor: {
      profileId: r.doctor_profile_id,
      displayName: r.display_name,
      verificationStatus: r.verification_status,
    },
    status: r.status,
    notes: r.notes,
    /** True when the doctor can actually work here now (future booking must require it). */
    effective: blockers.length === 0,
    blockers,
    createdAt: iso(r.created_at),
    deactivatedAt: iso(r.deactivated_at),
    deactivationReason: r.deactivation_reason,
  };
}

export type AssignmentView = ReturnType<typeof toAssignmentView>;

/**
 * Doctor ↔ branch assignments (clinic-specific working arrangement). Writes need
 * `clinic.doctors.manage`; reads need `clinic.schedules.view` for the assignment's branch.
 * Eligibility (DOCTOR membership active and covering the branch, global profile VERIFIED and
 * ACTIVE) is checked inside the transaction after the clinic lock, and re-evaluated on every
 * read (`effective`/`blockers`) instead of being copied, so membership, profile and assignment
 * statuses stay independent.
 */
export class DoctorAssignmentService {
  constructor(private readonly deps: SetupDeps) {}

  async listForBranch(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    filter: { status?: AssignmentStatus | undefined; limit: number; cursor?: string | undefined },
  ) {
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.schedules.view');
    const rows = await tenantExecutor(this.deps.db, bt.scope).query<AssignmentRow>(
      `${ASSIGNMENT_SELECT}
        WHERE a.clinic_id = ? AND a.branch_id = ? AND (? IS NULL OR a.status = ?) AND (? IS NULL OR a.id < ?)
        ORDER BY a.id DESC LIMIT ?`,
      [
        bt.clinicId,
        branchId,
        filter.status ?? null,
        filter.status ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    const now = this.deps.clock();
    return toPage(
      rows.map((r) => toAssignmentView(r, now)),
      filter.limit,
    );
  }

  /** A doctor's (membership's) assignments, limited to branches the caller may view. */
  async listForDoctor(
    actor: Principal,
    tenant: TenantContext,
    membershipId: string,
    filter: { status?: AssignmentStatus | undefined },
  ): Promise<AssignmentView[]> {
    if (!(await this.anyView(actor, tenant)))
      throw new ForbiddenError('You do not have permission to perform this action');
    const member = await tenantExecutor(this.deps.db, tenant.scope).query(
      'SELECT id FROM clinic_memberships WHERE id = ? AND clinic_id = ?',
      [membershipId, tenant.clinicId],
    );
    // A membership of another clinic is indistinguishable from a missing one.
    if (member.length === 0) throw new NotFoundError('Doctor not found');
    const rows = await tenantExecutor(this.deps.db, tenant.scope).query<AssignmentRow>(
      `${ASSIGNMENT_SELECT}
        WHERE a.clinic_id = ? AND a.membership_id = ? AND (? IS NULL OR a.status = ?)
        ORDER BY a.id DESC LIMIT 200`,
      [tenant.clinicId, membershipId, filter.status ?? null, filter.status ?? null],
    );
    const visible = await this.visibleBranches(
      actor,
      tenant,
      rows.map((r) => r.branch_id),
    );
    const now = this.deps.clock();
    return rows.filter((r) => visible.has(r.branch_id)).map((r) => toAssignmentView(r, now));
  }

  /** The caller's own assignments in this clinic (doctors). */
  async mine(actor: Principal, tenant: TenantContext): Promise<AssignmentView[]> {
    await this.deps.authz.assert(actor, 'clinic.profile.view', { tenant });
    const rows = await tenantExecutor(this.deps.db, tenant.scope).query<AssignmentRow>(
      `${ASSIGNMENT_SELECT} WHERE a.clinic_id = ? AND m.user_id = ? ORDER BY a.id DESC LIMIT 200`,
      [tenant.clinicId, actor.userId],
    );
    const now = this.deps.clock();
    return rows.map((r) => toAssignmentView(r, now));
  }

  async get(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
  ): Promise<AssignmentView> {
    const row = await loadAssignment(this.deps.db, tenant, assignmentId);
    await authorizeBranch(this.deps, actor, tenant, row.branch_id, 'clinic.schedules.view');
    return toAssignmentView(row, this.deps.clock());
  }

  async assign(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    input: { membershipId: string; notes?: string | null | undefined },
    meta: RequestMeta,
  ): Promise<AssignmentView> {
    await this.deps.authz.assert(actor, 'clinic.doctors.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      const t = tenantExecutor(tx, tenant.scope);
      await loadBranch(tx, tenant, branchId);
      const now = this.deps.clock();
      const membership = (
        await t.query<{
          id: string;
          user_id: string;
          role_code: string;
          membership_status: string;
          m_from: Date | null;
          m_until: Date | null;
          covered: string | number;
        }>(
          `SELECT m.id, m.user_id, m.role_code, m.status AS membership_status, m.effective_from AS m_from,
                  m.effective_until AS m_until,
                  (m.branch_scope = 'ALL' OR EXISTS (SELECT 1 FROM clinic_membership_branches mb
                     WHERE mb.membership_id = m.id AND mb.branch_id = ?)) AS covered
             FROM clinic_memberships m WHERE m.id = ? AND m.clinic_id = ? FOR UPDATE`,
          [branchId, input.membershipId, tenant.clinicId],
        )
      )[0];
      // A membership of another clinic is indistinguishable from a missing one.
      if (membership === undefined) throw new NotFoundError('Membership not found');
      const profile = (
        await tx.query<{ id: string; verification_status: string; profile_status: string }>(
          'SELECT id, verification_status, profile_status FROM doctor_profiles WHERE user_id = ?',
          [membership.user_id],
        )
      )[0];
      const reasons = [
        ...(membership.role_code === 'DOCTOR' ? [] : ['NOT_A_DOCTOR_MEMBERSHIP']),
        ...(membershipUsable(membership, now) ? [] : ['MEMBERSHIP_INACTIVE']),
        ...(Number(membership.covered) === 1 ? [] : ['BRANCH_NOT_COVERED']),
        ...(profile === undefined ? ['NO_DOCTOR_PROFILE'] : []),
        ...(profile !== undefined && profile.verification_status !== 'VERIFIED'
          ? ['DOCTOR_NOT_VERIFIED']
          : []),
        ...(profile !== undefined && profile.profile_status !== 'ACTIVE'
          ? ['DOCTOR_PROFILE_INACTIVE']
          : []),
      ];
      if (reasons.length > 0 || profile === undefined)
        throw new AppError(
          422,
          'DOCTOR_NOT_ELIGIBLE',
          'The doctor cannot be assigned to this branch',
          {
            details: { reasons },
          },
        );
      const existing = await t.query(
        `SELECT id FROM doctor_branch_assignments WHERE clinic_id = ? AND branch_id = ? AND membership_id = ? AND status = 'ACTIVE'`,
        [tenant.clinicId, branchId, membership.id],
      );
      if (existing.length > 0)
        throw new AppError(
          409,
          'ASSIGNMENT_EXISTS',
          'The doctor is already assigned to this branch',
        );
      const id = String(
        (
          await t.execute(
            `INSERT INTO doctor_branch_assignments (clinic_id, branch_id, membership_id, doctor_profile_id, notes, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              tenant.clinicId,
              branchId,
              membership.id,
              profile.id,
              input.notes ?? null,
              actor.userId,
            ],
          )
        ).insertId,
      );
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.DOCTOR_ASSIGNMENT_CREATED,
          actor,
          tenant,
          targetType: 'DOCTOR_ASSIGNMENT',
          targetId: id,
          metadata: { branchId, membershipId: membership.id, doctorProfileId: profile.id },
          event: 'doctor_assignment.created',
        },
        meta,
      );
      return toAssignmentView(await loadAssignment(tx, tenant, id), now);
    });
  }

  async updateNotes(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    notes: string | null,
    meta: RequestMeta,
  ): Promise<AssignmentView> {
    await this.deps.authz.assert(actor, 'clinic.doctors.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      const before = await loadAssignment(tx, tenant, assignmentId, true);
      if (before.status !== 'ACTIVE') throw new ConflictError('The assignment is inactive');
      await tenantExecutor(tx, tenant.scope).execute(
        'UPDATE doctor_branch_assignments SET notes = ? WHERE id = ? AND clinic_id = ?',
        [notes, assignmentId, tenant.clinicId],
      );
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.DOCTOR_ASSIGNMENT_CHANGED,
          actor,
          tenant,
          targetType: 'DOCTOR_ASSIGNMENT',
          targetId: assignmentId,
          metadata: { changed: ['notes'], before: before.notes, after: notes },
          event: 'doctor_assignment.changed',
        },
        meta,
      );
      return toAssignmentView(await loadAssignment(tx, tenant, assignmentId), this.deps.clock());
    });
  }

  /**
   * Deactivates an assignment. Nothing is deleted: the row, its schedules, exceptions and service
   * assignments stay as history; active schedules are deactivated and active service assignments
   * ended in the same transaction so no dangling active configuration remains.
   */
  async deactivate(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AssignmentView> {
    await this.deps.authz.assert(actor, 'clinic.doctors.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      const before = await loadAssignment(tx, tenant, assignmentId, true);
      if (before.status !== 'ACTIVE') throw new ConflictError('The assignment is already inactive');
      const now = this.deps.clock();
      const t = tenantExecutor(tx, tenant.scope);
      await t.execute(
        `UPDATE doctor_branch_assignments SET status = 'INACTIVE', deactivated_at = ?, deactivated_by_user_id = ?, deactivation_reason = ?
          WHERE id = ? AND clinic_id = ?`,
        [now, actor.userId, reason, assignmentId, tenant.clinicId],
      );
      const schedules = await t.execute(
        `UPDATE schedules SET status = 'INACTIVE', deactivated_at = ?, deactivated_by_user_id = ?, deactivation_reason = 'ASSIGNMENT_DEACTIVATED'
          WHERE clinic_id = ? AND assignment_id = ? AND status = 'ACTIVE'`,
        [now, actor.userId, tenant.clinicId, assignmentId],
      );
      const services = await t.execute(
        `UPDATE doctor_service_assignments SET status = 'ENDED', ended_at = ?, ended_by_user_id = ?
          WHERE clinic_id = ? AND assignment_id = ? AND status = 'ACTIVE'`,
        [now, actor.userId, tenant.clinicId, assignmentId],
      );
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.DOCTOR_ASSIGNMENT_CHANGED,
          actor,
          tenant,
          targetType: 'DOCTOR_ASSIGNMENT',
          targetId: assignmentId,
          metadata: {
            from: 'ACTIVE',
            to: 'INACTIVE',
            reason,
            branchId: before.branch_id,
            schedulesDeactivated: schedules.affectedRows,
            servicesEnded: services.affectedRows,
          },
          event: 'doctor_assignment.deactivated',
        },
        meta,
      );
      return toAssignmentView(await loadAssignment(tx, tenant, assignmentId), now);
    });
  }

  private async visibleBranches(
    actor: Principal,
    tenant: TenantContext,
    branchIds: readonly string[],
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const id of new Set(branchIds)) {
      try {
        const bt = await branchTenant(this.deps, actor, tenant, id);
        if ((await this.deps.authz.check(actor, 'clinic.schedules.view', { tenant: bt })).allowed)
          out.add(id);
      } catch {
        // not covered → invisible
      }
    }
    return out;
  }

  private async anyView(actor: Principal, tenant: TenantContext): Promise<boolean> {
    const decision = await this.deps.authz.check(actor, 'clinic.schedules.view', { tenant });
    return decision.allowed || decision.reason === 'BRANCH_CONTEXT_REQUIRED';
  }
}
