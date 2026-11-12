import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError, NotFoundError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import {
  BranchAccessDeniedError,
  tenantExecutor,
  type AuthorizationService,
  type Permission,
  type Principal,
  type TenantContext,
  type TenantContextResolver,
} from '../access/index.js';
import type { AuditAction, AuditLog, AuditTargetType } from '../audit/index.js';
import type { DomainEventOutbox, PlatformSettingsService } from '../platform/index.js';

export interface SetupDeps {
  readonly db: Database;
  readonly authz: AuthorizationService;
  readonly resolver: TenantContextResolver;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
  readonly settings: PlatformSettingsService;
  readonly clock: Clock;
  /** Clinic row lock (ADR-034): first lock of every clinic-setup write. */
  readonly lockClinic: (tx: SqlExecutor, clinicId: string) => Promise<void>;
}

/**
 * Tenant context for a branch named in the URL. The branch is re-resolved through the same
 * resolver as `X-Branch-Id` (active membership covering that branch, branch of this clinic), so
 * branch-assigned staff can never act on, or learn about, branches they are not assigned to:
 * an uncovered or foreign branch is a 404.
 */
export async function branchTenant(
  deps: Pick<SetupDeps, 'resolver'>,
  actor: Principal,
  tenant: TenantContext,
  branchId: string,
): Promise<TenantContext> {
  if (tenant.branchId === branchId) return tenant;
  try {
    return await deps.resolver.resolve(actor.userId, tenant.clinicId, branchId);
  } catch (err) {
    if (err instanceof BranchAccessDeniedError) throw new NotFoundError('Branch not found');
    throw err;
  }
}

/** Authorizes `permission` against the branch in the URL; returns that branch's context. */
export async function authorizeBranch(
  deps: Pick<SetupDeps, 'resolver' | 'authz'>,
  actor: Principal,
  tenant: TenantContext,
  branchId: string,
  permission: Permission,
): Promise<TenantContext> {
  const bt = await branchTenant(deps, actor, tenant, branchId);
  await deps.authz.assert(actor, permission, { tenant: bt });
  return bt;
}

/** Branch of this clinic, optionally locked. 404 for unknown or foreign ids. */
export async function loadBranch(
  executor: SqlExecutor,
  tenant: TenantContext,
  branchId: string,
  forUpdate = false,
): Promise<{ id: string; name: string; timeZone: string; status: 'ACTIVE' | 'INACTIVE' }> {
  const rows = await tenantExecutor(executor, tenant.scope).query<{
    id: string;
    name: string;
    time_zone: string;
    status: 'ACTIVE' | 'INACTIVE';
  }>(
    `SELECT id, name, time_zone, status FROM clinic_branches WHERE id = ? AND clinic_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, tenant.clinicId],
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Branch not found');
  return { id: row.id, name: row.name, timeZone: row.time_zone, status: row.status };
}

// ---------- doctor assignment eligibility ----------

/** Why an assignment cannot be used now. Empty = effective. */
export type AssignmentBlocker =
  | 'ASSIGNMENT_INACTIVE'
  | 'MEMBERSHIP_INACTIVE'
  | 'BRANCH_NOT_COVERED'
  | 'DOCTOR_NOT_VERIFIED'
  | 'DOCTOR_PROFILE_INACTIVE'
  | 'BRANCH_INACTIVE';

export interface AssignmentRow {
  id: string;
  clinic_id: string;
  branch_id: string;
  membership_id: string;
  doctor_profile_id: string;
  status: 'ACTIVE' | 'INACTIVE';
  notes: string | null;
  created_at: Date;
  deactivated_at: Date | null;
  deactivation_reason: string | null;
  branch_name: string;
  time_zone: string;
  branch_status: 'ACTIVE' | 'INACTIVE';
  display_name: string;
  verification_status: string;
  profile_status: string;
  user_id: string;
  membership_status: string;
  m_from: Date | null;
  m_until: Date | null;
  covered: string | number;
}

/**
 * Assignment with everything needed to decide eligibility: the DOCTOR membership (status,
 * window, branch coverage), the global doctor profile and the branch. All joins stay in the
 * assignment's clinic.
 */
export const ASSIGNMENT_SELECT = `
  SELECT a.id, a.clinic_id, a.branch_id, a.membership_id, a.doctor_profile_id, a.status, a.notes,
         a.created_at, a.deactivated_at, a.deactivation_reason,
         b.name AS branch_name, b.time_zone, b.status AS branch_status,
         dp.display_name, dp.verification_status, dp.profile_status,
         m.user_id, m.status AS membership_status, m.effective_from AS m_from, m.effective_until AS m_until,
         (m.branch_scope = 'ALL' OR EXISTS (SELECT 1 FROM clinic_membership_branches mb
            WHERE mb.membership_id = m.id AND mb.branch_id = a.branch_id)) AS covered
    FROM doctor_branch_assignments a
    JOIN clinic_branches b ON b.id = a.branch_id AND b.clinic_id = a.clinic_id
    JOIN clinic_memberships m ON m.id = a.membership_id AND m.clinic_id = a.clinic_id
    JOIN doctor_profiles dp ON dp.id = a.doctor_profile_id`;

export function membershipUsable(
  row: { membership_status: string; m_from: Date | null; m_until: Date | null },
  now: Date,
): boolean {
  return (
    row.membership_status === 'ACTIVE' &&
    (row.m_from === null || row.m_from <= now) &&
    (row.m_until === null || row.m_until > now)
  );
}

export function assignmentBlockers(row: AssignmentRow, now: Date): AssignmentBlocker[] {
  const blockers: AssignmentBlocker[] = [];
  if (row.status !== 'ACTIVE') blockers.push('ASSIGNMENT_INACTIVE');
  if (!membershipUsable(row, now)) blockers.push('MEMBERSHIP_INACTIVE');
  if (Number(row.covered) !== 1) blockers.push('BRANCH_NOT_COVERED');
  if (row.verification_status !== 'VERIFIED') blockers.push('DOCTOR_NOT_VERIFIED');
  if (row.profile_status !== 'ACTIVE') blockers.push('DOCTOR_PROFILE_INACTIVE');
  if (row.branch_status !== 'ACTIVE') blockers.push('BRANCH_INACTIVE');
  return blockers;
}

/**
 * Configuration (services, schedules) may be changed for an assignment whose doctor is eligible;
 * an inactive branch does not block configuration (only new operations, ADR-026).
 */
export function assertConfigurable(row: AssignmentRow, now: Date): void {
  const blockers = assignmentBlockers(row, now).filter((b) => b !== 'BRANCH_INACTIVE');
  if (blockers.length > 0)
    throw new AppError(
      409,
      'ASSIGNMENT_NOT_ELIGIBLE',
      'The doctor assignment cannot be configured',
      {
        details: { blockers },
      },
    );
}

export async function loadAssignment(
  executor: SqlExecutor,
  tenant: TenantContext,
  assignmentId: string,
  forUpdate = false,
): Promise<AssignmentRow> {
  const rows = await tenantExecutor(executor, tenant.scope).query<AssignmentRow>(
    `${ASSIGNMENT_SELECT} WHERE a.id = ? AND a.clinic_id = ?${forUpdate ? ' FOR UPDATE OF a' : ''}`,
    [assignmentId, tenant.clinicId],
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Doctor assignment not found');
  return row;
}

/** Records audit (same transaction) and an outbox event for a clinic-setup change. */
export async function recordChange(
  deps: Pick<SetupDeps, 'auditLog' | 'outbox'>,
  tx: SqlExecutor,
  input: {
    action: AuditAction;
    actor: Principal;
    tenant: TenantContext;
    targetType: AuditTargetType;
    targetId: string;
    metadata: Record<string, unknown>;
    event: string;
  },
  meta: RequestMeta,
): Promise<void> {
  await deps.auditLog.record(
    tx,
    {
      action: input.action,
      actorUserId: input.actor.userId,
      targetType: input.targetType,
      targetId: input.targetId,
      clinicId: input.tenant.clinicId,
      metadata: input.metadata,
    },
    meta,
  );
  await deps.outbox.record(tx, {
    type: input.event,
    aggregateType: input.targetType.toLowerCase(),
    aggregateId: input.targetId,
    clinicId: input.tenant.clinicId,
    payload: { targetId: input.targetId, ...pickIds(input.metadata) },
  });
}

/** Outbox payloads carry ids and statuses only (no prices, notes or free text). */
function pickIds(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([k, v]) => (k.endsWith('Id') || k === 'status' || k === 'to') && typeof v !== 'object',
    ),
  );
}

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
