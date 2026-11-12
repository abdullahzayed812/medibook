import type { SqlExecutor } from '../../../infrastructure/database/database.js';
import type { ClinicRole } from '../authorization/catalog.js';

export const MEMBERSHIP_STATUSES = [
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'INACTIVE',
  'TERMINATED',
] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type BranchScope = 'ALL' | 'ASSIGNED';

/** A membership that is ACTIVE and inside its effective window at evaluation time. */
export interface ActiveMembership {
  readonly id: string;
  readonly role: ClinicRole;
  readonly branchScope: BranchScope;
  readonly branchIds: readonly string[];
}

export interface MembershipRecord {
  readonly id: string;
  readonly clinicId: string;
  readonly clinicName: string;
  readonly userId: string;
  readonly role: ClinicRole;
  readonly status: MembershipStatus;
  readonly branchScope: BranchScope;
  readonly branchIds: readonly string[];
  readonly effectiveFrom: Date | null;
  readonly effectiveUntil: Date | null;
  readonly activatedAt: Date | null;
  readonly terminatedAt: Date | null;
}

interface MembershipRow {
  id: string;
  clinic_id: string;
  clinic_name: string;
  user_id: string;
  role_code: ClinicRole;
  status: MembershipStatus;
  branch_scope: BranchScope;
  branch_ids: string | null;
  effective_from: Date | null;
  effective_until: Date | null;
  activated_at: Date | null;
  terminated_at: Date | null;
}

/** SQL predicate for "membership grants access right now" (m = clinic_memberships alias). */
const ACTIVE_NOW = `m.status = 'ACTIVE'
  AND (m.effective_from IS NULL OR m.effective_from <= ?)
  AND (m.effective_until IS NULL OR m.effective_until > ?)`;

const SELECT_MEMBERSHIP = `
  SELECT m.id, m.clinic_id, c.name AS clinic_name, m.user_id, m.role_code, m.status, m.branch_scope,
         (SELECT GROUP_CONCAT(b.branch_id ORDER BY b.branch_id)
            FROM clinic_membership_branches b WHERE b.membership_id = m.id) AS branch_ids,
         m.effective_from, m.effective_until, m.activated_at, m.terminated_at
    FROM clinic_memberships m
    JOIN clinics c ON c.id = m.clinic_id`;

function splitIds(value: string | null): string[] {
  return value === null || value === '' ? [] : value.split(',');
}

function toRecord(row: MembershipRow): MembershipRecord {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    clinicName: row.clinic_name,
    userId: row.user_id,
    role: row.role_code,
    status: row.status,
    branchScope: row.branch_scope,
    branchIds: splitIds(row.branch_ids),
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    activatedAt: row.activated_at,
    terminatedAt: row.terminated_at,
  };
}

export class MembershipsRepository {
  async findActive(
    executor: SqlExecutor,
    userId: string,
    clinicId: string,
    now: Date,
  ): Promise<ActiveMembership[]> {
    const rows = await executor.query<MembershipRow>(
      `${SELECT_MEMBERSHIP} WHERE m.user_id = ? AND m.clinic_id = ? AND ${ACTIVE_NOW} ORDER BY m.id`,
      [userId, clinicId, now, now],
    );
    return rows.map((row) => ({
      id: row.id,
      role: row.role_code,
      branchScope: row.branch_scope,
      branchIds: splitIds(row.branch_ids),
    }));
  }

  async listForUser(executor: SqlExecutor, userId: string): Promise<MembershipRecord[]> {
    const rows = await executor.query<MembershipRow>(
      `${SELECT_MEMBERSHIP} WHERE m.user_id = ? ORDER BY m.clinic_id, m.id`,
      [userId],
    );
    return rows.map(toRecord);
  }

  async listActiveForUser(
    executor: SqlExecutor,
    userId: string,
    now: Date,
  ): Promise<MembershipRecord[]> {
    const rows = await executor.query<MembershipRow>(
      `${SELECT_MEMBERSHIP} WHERE m.user_id = ? AND ${ACTIVE_NOW} ORDER BY m.clinic_id, m.id`,
      [userId, now, now],
    );
    return rows.map(toRecord);
  }

  async lockInClinic(
    executor: SqlExecutor,
    clinicId: string,
    membershipId: string,
  ): Promise<MembershipRecord | undefined> {
    const rows = await executor.query<MembershipRow>(
      `${SELECT_MEMBERSHIP} WHERE m.id = ? AND m.clinic_id = ? FOR UPDATE`,
      [membershipId, clinicId],
    );
    return rows[0] === undefined ? undefined : toRecord(rows[0]);
  }

  /** Any-status membership rows of a user in a clinic (locked when used for changes). */
  async listForUserInClinic(
    executor: SqlExecutor,
    clinicId: string,
    userId: string,
    forUpdate = false,
  ): Promise<MembershipRecord[]> {
    const rows = await executor.query<MembershipRow>(
      `${SELECT_MEMBERSHIP} WHERE m.clinic_id = ? AND m.user_id = ? ORDER BY m.id${forUpdate ? ' FOR UPDATE OF m' : ''}`,
      [clinicId, userId],
    );
    return rows.map(toRecord);
  }

  async branchExists(executor: SqlExecutor, clinicId: string, branchId: string): Promise<boolean> {
    const rows = await executor.query<{ id: string }>(
      'SELECT id FROM clinic_branches WHERE id = ? AND clinic_id = ?',
      [branchId, clinicId],
    );
    return rows.length === 1;
  }

  async listBranches(
    executor: SqlExecutor,
    clinicId: string,
    restrictTo: readonly string[] | 'ALL',
  ): Promise<{ id: string; name: string }[]> {
    if (restrictTo !== 'ALL' && restrictTo.length === 0) return [];
    const filter =
      restrictTo === 'ALL' ? '' : ` AND id IN (${restrictTo.map(() => '?').join(', ')})`;
    return executor.query<{ id: string; name: string }>(
      `SELECT id, name FROM clinic_branches WHERE clinic_id = ?${filter} ORDER BY name, id`,
      [clinicId, ...(restrictTo === 'ALL' ? [] : restrictTo)],
    );
  }

  async insert(
    executor: SqlExecutor,
    input: {
      clinicId: string;
      userId: string;
      role: ClinicRole;
      branchScope: BranchScope;
      effectiveFrom: Date | null;
      effectiveUntil: Date | null;
      createdBy: string;
      now: Date;
    },
  ): Promise<string> {
    const result = await executor.execute(
      `INSERT INTO clinic_memberships
         (clinic_id, user_id, role_code, status, branch_scope, effective_from, effective_until,
          activated_at, created_by_user_id)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
      [
        input.clinicId,
        input.userId,
        input.role,
        input.branchScope,
        input.effectiveFrom,
        input.effectiveUntil,
        input.now,
        input.createdBy,
      ],
    );
    return String(result.insertId);
  }

  async updateStatus(
    executor: SqlExecutor,
    clinicId: string,
    membershipId: string,
    status: MembershipStatus,
    now: Date,
  ): Promise<void> {
    await executor.execute(
      `UPDATE clinic_memberships
          SET status = ?,
              activated_at = IF(? = 'ACTIVE', ?, activated_at),
              terminated_at = IF(? = 'TERMINATED', ?, IF(? = 'ACTIVE', NULL, terminated_at))
        WHERE id = ? AND clinic_id = ?`,
      [status, status, now, status, now, status, membershipId, clinicId],
    );
  }

  /**
   * Starts a NEW membership period on an existing (clinic, user, role) row, which the unique key
   * makes the only row for that role. Unlike `updateStatus`, it replaces the effective window, so
   * a stale `effective_until` from an earlier period can never leave a re-granted membership
   * ACTIVE but not effective. The caller records the previous period (`membershipPeriod`) in
   * the audit log first, so history is preserved; branches are set separately (replaceBranches).
   */
  async reactivateAsNewPeriod(
    executor: SqlExecutor,
    clinicId: string,
    membershipId: string,
    period: { effectiveFrom: Date | null; effectiveUntil: Date | null },
    now: Date,
  ): Promise<void> {
    await executor.execute(
      `UPDATE clinic_memberships
          SET status = 'ACTIVE', effective_from = ?, effective_until = ?, activated_at = ?, terminated_at = NULL
        WHERE id = ? AND clinic_id = ?`,
      [period.effectiveFrom, period.effectiveUntil, now, membershipId, clinicId],
    );
  }

  /** Replaces branch assignments; composite FKs reject branches of another clinic. */
  async replaceBranches(
    executor: SqlExecutor,
    clinicId: string,
    membershipId: string,
    branchScope: BranchScope,
    branchIds: readonly string[],
  ): Promise<void> {
    await executor.execute(
      'UPDATE clinic_memberships SET branch_scope = ? WHERE id = ? AND clinic_id = ?',
      [branchScope, membershipId, clinicId],
    );
    await executor.execute(
      'DELETE FROM clinic_membership_branches WHERE membership_id = ? AND clinic_id = ?',
      [membershipId, clinicId],
    );
    for (const branchId of branchScope === 'ALL' ? [] : branchIds) {
      await executor.execute(
        'INSERT INTO clinic_membership_branches (membership_id, clinic_id, branch_id) VALUES (?, ?, ?)',
        [membershipId, clinicId, branchId],
      );
    }
  }

  async insertEvent(
    executor: SqlExecutor,
    input: {
      membershipId: string;
      clinicId: string;
      fromStatus: MembershipStatus | null;
      toStatus: MembershipStatus;
      actorUserId: string;
      reason: string | null;
    },
  ): Promise<void> {
    await executor.execute(
      `INSERT INTO clinic_membership_events (membership_id, clinic_id, from_status, to_status, actor_user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.membershipId,
        input.clinicId,
        input.fromStatus,
        input.toStatus,
        input.actorUserId,
        input.reason,
      ],
    );
  }

  /** Clears a remembered clinic context when the user no longer has access to that clinic. */
  async clearActiveClinicIfNoAccess(
    executor: SqlExecutor,
    userId: string,
    clinicId: string,
    now: Date,
  ): Promise<void> {
    await executor.execute(
      `UPDATE sessions SET active_clinic_id = NULL
        WHERE user_id = ? AND active_clinic_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM clinic_memberships m
             WHERE m.user_id = ? AND m.clinic_id = ? AND ${ACTIVE_NOW})`,
      [userId, clinicId, userId, clinicId, now, now],
    );
  }
}

/** True when an ACTIVE membership's effective window has already ended at `now`. */
export function isPeriodEnded(m: Pick<MembershipRecord, 'effectiveUntil'>, now: Date): boolean {
  return m.effectiveUntil !== null && m.effectiveUntil.getTime() <= now.getTime();
}

/** Snapshot of a membership period for audit metadata (kept before a row is re-used). */
export function membershipPeriod(m: MembershipRecord) {
  return {
    status: m.status,
    branchScope: m.branchScope,
    branchIds: m.branchIds,
    effectiveFrom: m.effectiveFrom,
    effectiveUntil: m.effectiveUntil,
    activatedAt: m.activatedAt,
    terminatedAt: m.terminatedAt,
  };
}
