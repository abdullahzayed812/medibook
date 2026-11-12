import type { SqlExecutor } from '../../infrastructure/database/database.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import { tenantExecutor, type Principal, type TenantContext } from '../access/index.js';
import { AUDIT_ACTION } from '../audit/index.js';
import {
  assertConfigurable,
  assignmentBlockers,
  authorizeBranch,
  iso,
  loadAssignment,
  loadBranch,
  recordChange,
  type AssignmentRow,
  type SetupDeps,
} from './context.js';
import {
  attachPeriods,
  dayResolver as resolver,
  EXCEPTION_SELECT,
  loadExceptions,
  loadSchedules,
  SCHEDULE_SELECT,
  scheduleOn,
  toException,
  type ExceptionKind,
  type ExceptionRecord,
  type OwnerType,
  type ScheduleFilter,
  type ScheduleRecord,
} from './schedule-data.js';
import { addDays, daysBetween, isoWeekday, localDate, localRangeToUtc } from './time-zone.js';
import {
  dayName,
  formatClock,
  FOREVER,
  intersect,
  merge,
  overlaps,
  rangesOverlap,
  subtract,
  uncoveredRanges,
  validatePeriods,
  weeklyAvailability,
  type DateRange,
  type Interval,
  type Period,
} from './weekly.js';

export type { ExceptionKind, ExceptionRecord, OwnerType, ScheduleRecord } from './schedule-data.js';

/** Cross-branch conflicts are checked over this many days from the later of today and the start. */
export const CONFLICT_HORIZON_DAYS = 371;
/** Longest CLOSED exception and longest working-time query. */
export const MAX_CLOSED_DAYS = 366;
export const MAX_WORKING_TIME_DAYS = 62;

export interface ScheduleInput {
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string | null | undefined;
  readonly note?: string | null | undefined;
  readonly periods: readonly Period[];
}

export interface ExceptionInput {
  readonly kind: ExceptionKind;
  readonly startDate: string;
  readonly endDate?: string | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly reason: string;
}

type Row = Record<string, unknown>;

export function scheduleView(s: ScheduleRecord) {
  return {
    id: s.id,
    branchId: s.branchId,
    ownerType: s.ownerType,
    assignmentId: s.assignmentId,
    status: s.status,
    effectiveFrom: s.from,
    effectiveUntil: s.until,
    revision: s.revision,
    supersedesScheduleId: s.supersedesScheduleId,
    note: s.note,
    periods: [...s.periods]
      .sort((a, b) => a.day - b.day || a.start - b.start || (a.kind === 'WORK' ? -1 : 1))
      .map((p) => ({
        day: dayName(p.day),
        kind: p.kind,
        start: formatClock(p.start),
        end: formatClock(p.end),
      })),
    createdAt: iso(s.createdAt),
    deactivatedAt: iso(s.deactivatedAt),
    deactivationReason: s.deactivationReason,
  };
}

export function exceptionView(e: ExceptionRecord) {
  return {
    id: e.id,
    branchId: e.branchId,
    ownerType: e.ownerType,
    assignmentId: e.assignmentId,
    kind: e.kind,
    startDate: e.startDate,
    endDate: e.endDate,
    start: e.start === null ? null : formatClock(e.start),
    end: e.end === null ? null : formatClock(e.end),
    reason: e.reason,
    status: e.status,
    createdAt: iso(e.createdAt),
    cancelledAt: iso(e.cancelledAt),
  };
}

const conflict = (code: string, message: string, details: unknown) =>
  new AppError(409, code, message, { details });

/**
 * Branch operating hours and doctor working schedules (recurring weekly versions plus dated
 * exceptions), and the resolved working time a future Booking Engine will consume.
 *
 * Every write runs in one transaction that FIRST locks the clinic row (ADR-034) and only then
 * reads and validates current state, so two concurrent conflicting writes serialize and the
 * second one sees the first. Validation applies from the branch's local "today" onward; the past
 * is history and is never re-validated or rewritten.
 */
export class ScheduleService {
  constructor(private readonly deps: SetupDeps) {}

  // =====================================================================================
  // Reads
  // =====================================================================================

  async listBranchHours(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    filter: {
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.schedules.view');
    const rows = await this.schedules(this.deps.db, bt, {
      branchId,
      ownerType: 'BRANCH',
      status: filter.status,
      cursor: filter.cursor,
      limit: filter.limit + 1,
    });
    return toPage(rows.map(scheduleView), filter.limit);
  }

  async listDoctorSchedules(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    filter: {
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    const a = await loadAssignment(this.deps.db, tenant, assignmentId);
    const bt = await authorizeBranch(
      this.deps,
      actor,
      tenant,
      a.branch_id,
      'clinic.schedules.view',
    );
    const rows = await this.schedules(this.deps.db, bt, {
      assignmentId,
      ownerType: 'DOCTOR',
      status: filter.status,
      cursor: filter.cursor,
      limit: filter.limit + 1,
    });
    return toPage(rows.map(scheduleView), filter.limit);
  }

  async getSchedule(actor: Principal, tenant: TenantContext, scheduleId: string) {
    const s = await this.loadSchedule(this.deps.db, tenant, scheduleId);
    await authorizeBranch(this.deps, actor, tenant, s.branchId, 'clinic.schedules.view');
    return scheduleView(s);
  }

  async listExceptions(
    actor: Principal,
    tenant: TenantContext,
    owner: { branchId: string } | { assignmentId: string },
    filter: {
      status?: 'ACTIVE' | 'CANCELLED' | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    let branchId: string;
    if ('assignmentId' in owner)
      branchId = (await loadAssignment(this.deps.db, tenant, owner.assignmentId)).branch_id;
    else branchId = owner.branchId;
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.schedules.view');
    const rows = await tenantExecutor(this.deps.db, bt.scope).query<Row>(
      `${EXCEPTION_SELECT} WHERE e.clinic_id = ? AND e.branch_id = ? AND e.owner_type = ?
          AND (? IS NULL OR e.assignment_id = ?) AND (? IS NULL OR e.status = ?)
          AND (? IS NULL OR e.end_date >= ?) AND (? IS NULL OR e.start_date <= ?)
          AND (? IS NULL OR e.id < ?) ORDER BY e.id DESC LIMIT ?`,
      [
        bt.clinicId,
        branchId,
        'assignmentId' in owner ? 'DOCTOR' : 'BRANCH',
        ...twice('assignmentId' in owner ? owner.assignmentId : null),
        ...twice(filter.status ?? null),
        ...twice(filter.from ?? null),
        ...twice(filter.to ?? null),
        ...twice(filter.cursor ?? null),
        filter.limit + 1,
      ],
    );
    return toPage(rows.map(toException).map(exceptionView), filter.limit);
  }

  /** Resolved branch opening time per local date (weekly hours ± branch exceptions). */
  async branchOpeningTime(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    range: { from: string; to: string },
  ) {
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.schedules.view');
    assertQueryRange(range);
    const branch = await loadBranch(this.deps.db, bt, branchId);
    const ctx = await this.branchContext(this.deps.db, bt, branchId, range);
    return {
      branchId,
      timeZone: branch.timeZone,
      days: eachDate(range.from, range.to).map((date) =>
        dayView(branch.timeZone, date, ctx.branchDay(date)),
      ),
    };
  }

  /**
   * Resolved working time of a doctor at one branch: (doctor weekly ± doctor exceptions) ∩
   * (branch weekly ± branch exceptions), per local date, with real UTC instants. Empty when the
   * assignment is not effective. This is working time, not bookable slots.
   */
  async doctorWorkingTime(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    range: { from: string; to: string },
  ) {
    const a = await loadAssignment(this.deps.db, tenant, assignmentId);
    const bt = await authorizeBranch(
      this.deps,
      actor,
      tenant,
      a.branch_id,
      'clinic.schedules.view',
    );
    assertQueryRange(range);
    const blockers = assignmentBlockers(a, this.deps.clock());
    const branchCtx = await this.branchContext(this.deps.db, bt, a.branch_id, range);
    const doctorCtx = await this.doctorContext(this.deps.db, bt, assignmentId, range);
    return {
      assignmentId,
      branchId: a.branch_id,
      timeZone: a.time_zone,
      effective: blockers.length === 0,
      blockers,
      days: eachDate(range.from, range.to).map((date) =>
        dayView(
          a.time_zone,
          date,
          blockers.length === 0 ? intersect(doctorCtx.day(date), branchCtx.branchDay(date)) : [],
        ),
      ),
    };
  }

  // =====================================================================================
  // Branch operating hours
  // =====================================================================================

  async createBranchHours(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    input: ScheduleInput,
    meta: RequestMeta,
  ) {
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.schedules.manage');
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, bt.clinicId);
      const branch = await loadBranch(tx, bt, branchId);
      const today = localDate(branch.timeZone, this.deps.clock().getTime());
      const range = checkInput(input, today);
      const current = await this.schedules(tx, bt, {
        branchId,
        ownerType: 'BRANCH',
        status: 'ACTIVE',
      });
      assertNoOwnOverlap(current, range);
      const next = [...current, draft(branchId, 'BRANCH', null, range, input.periods)];
      await this.assertDoctorsStillContained(tx, bt, branchId, next, today);
      const id = await this.insertSchedule(
        tx,
        bt,
        branchId,
        'BRANCH',
        null,
        input,
        range,
        1,
        null,
        actor,
      );
      return this.audited(tx, bt, actor, id, 'SCHEDULE_CREATED', { ownerType: 'BRANCH' }, meta);
    });
  }

  // =====================================================================================
  // Doctor schedules
  // =====================================================================================

  async createDoctorSchedule(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    input: ScheduleInput,
    meta: RequestMeta,
  ) {
    const pre = await loadAssignment(this.deps.db, tenant, assignmentId);
    const bt = await authorizeBranch(
      this.deps,
      actor,
      tenant,
      pre.branch_id,
      'clinic.schedules.manage',
    );
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, bt.clinicId);
      const a = await loadAssignment(tx, bt, assignmentId, true);
      assertConfigurable(a, this.deps.clock());
      const today = localDate(a.time_zone, this.deps.clock().getTime());
      const range = checkInput(input, today);
      const own = await this.schedules(tx, bt, {
        assignmentId,
        ownerType: 'DOCTOR',
        status: 'ACTIVE',
      });
      assertNoOwnOverlap(own, range);
      const candidate = draft(a.branch_id, 'DOCTOR', assignmentId, range, input.periods);
      await this.assertDoctorScheduleValid(tx, bt, a, candidate, today);
      const id = await this.insertSchedule(
        tx,
        bt,
        a.branch_id,
        'DOCTOR',
        assignmentId,
        input,
        range,
        1,
        null,
        actor,
      );
      return this.audited(
        tx,
        bt,
        actor,
        id,
        'SCHEDULE_CREATED',
        { ownerType: 'DOCTOR', assignmentId },
        meta,
      );
    });
  }

  // =====================================================================================
  // Shared: revise, deactivate, activate
  // =====================================================================================

  /**
   * New revision of an ACTIVE schedule from `effectiveFrom`: the old version ends the day before
   * (or is deactivated as SUPERSEDED when the revision starts on its first day). The old version
   * and its periods stay unchanged as history.
   */
  async revise(
    actor: Principal,
    tenant: TenantContext,
    scheduleId: string,
    input: ScheduleInput,
    meta: RequestMeta,
  ) {
    const pre = await this.loadSchedule(this.deps.db, tenant, scheduleId);
    const bt = await authorizeBranch(
      this.deps,
      actor,
      tenant,
      pre.branchId,
      'clinic.schedules.manage',
    );
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, bt.clinicId);
      const old = await this.loadSchedule(tx, bt, scheduleId);
      if (old.status !== 'ACTIVE')
        throw new ConflictError('Only an active schedule can be revised');
      const branch = await loadBranch(tx, bt, old.branchId);
      const today = localDate(branch.timeZone, this.deps.clock().getTime());
      const range = checkInput(
        {
          ...input,
          effectiveUntil: input.effectiveUntil === undefined ? old.until : input.effectiveUntil,
        },
        today,
      );
      if (range.from < old.from || (old.until !== null && range.from > old.until))
        throw new ValidationError([
          {
            location: 'body',
            path: 'effectiveFrom',
            message: `must lie within the revised schedule (${old.from} … ${old.until ?? 'open-ended'})`,
          },
        ]);
      const replacesWhole = range.from === old.from;
      const oldAfter: ScheduleRecord | null = replacesWhole
        ? null
        : { ...old, until: addDays(range.from, -1) };
      const candidate = draft(old.branchId, old.ownerType, old.assignmentId, range, input.periods);

      if (old.ownerType === 'BRANCH') {
        const current = (
          await this.schedules(tx, bt, {
            branchId: old.branchId,
            ownerType: 'BRANCH',
            status: 'ACTIVE',
          })
        ).filter((s) => s.id !== old.id);
        assertNoOwnOverlap(current, range);
        const next = [...current, ...(oldAfter ? [oldAfter] : []), candidate];
        await this.assertDoctorsStillContained(tx, bt, old.branchId, next, today);
      } else {
        const a = await loadAssignment(tx, bt, old.assignmentId ?? '', true);
        assertConfigurable(a, this.deps.clock());
        const own = (
          await this.schedules(tx, bt, {
            assignmentId: a.id,
            ownerType: 'DOCTOR',
            status: 'ACTIVE',
          })
        ).filter((s) => s.id !== old.id);
        assertNoOwnOverlap(own, range);
        await this.assertDoctorScheduleValid(tx, bt, a, candidate, today, [old.id]);
      }

      const t = tenantExecutor(tx, bt.scope);
      if (replacesWhole)
        await t.execute(
          `UPDATE schedules SET status = 'INACTIVE', deactivated_at = ?, deactivated_by_user_id = ?, deactivation_reason = 'SUPERSEDED'
            WHERE id = ? AND clinic_id = ?`,
          [this.deps.clock(), actor.userId, old.id, bt.clinicId],
        );
      else
        await t.execute('UPDATE schedules SET effective_until = ? WHERE id = ? AND clinic_id = ?', [
          oldAfter?.until ?? null,
          old.id,
          bt.clinicId,
        ]);
      const id = await this.insertSchedule(
        tx,
        bt,
        old.branchId,
        old.ownerType,
        old.assignmentId,
        input,
        range,
        old.revision + 1,
        old.id,
        actor,
      );
      return this.audited(
        tx,
        bt,
        actor,
        id,
        'SCHEDULE_CREATED',
        {
          ownerType: old.ownerType,
          assignmentId: old.assignmentId,
          supersedesScheduleId: old.id,
          previousEffectiveUntil: old.until,
          previousEndedAs: replacesWhole ? 'SUPERSEDED' : (oldAfter?.until ?? null),
        },
        meta,
      );
    });
  }

  async deactivate(
    actor: Principal,
    tenant: TenantContext,
    scheduleId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    const pre = await this.loadSchedule(this.deps.db, tenant, scheduleId);
    const bt = await authorizeBranch(
      this.deps,
      actor,
      tenant,
      pre.branchId,
      'clinic.schedules.manage',
    );
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, bt.clinicId);
      const s = await this.loadSchedule(tx, bt, scheduleId);
      if (s.status !== 'ACTIVE') throw new ConflictError('The schedule is already inactive');
      if (s.ownerType === 'BRANCH') {
        const branch = await loadBranch(tx, bt, s.branchId);
        const today = localDate(branch.timeZone, this.deps.clock().getTime());
        const remaining = (
          await this.schedules(tx, bt, {
            branchId: s.branchId,
            ownerType: 'BRANCH',
            status: 'ACTIVE',
          })
        ).filter((x) => x.id !== s.id);
        await this.assertDoctorsStillContained(tx, bt, s.branchId, remaining, today);
      }
      await tenantExecutor(tx, bt.scope).execute(
        `UPDATE schedules SET status = 'INACTIVE', deactivated_at = ?, deactivated_by_user_id = ?, deactivation_reason = ?
          WHERE id = ? AND clinic_id = ?`,
        [this.deps.clock(), actor.userId, reason, s.id, bt.clinicId],
      );
      return this.audited(
        tx,
        bt,
        actor,
        s.id,
        'SCHEDULE_CHANGED',
        { from: 'ACTIVE', to: 'INACTIVE', reason },
        meta,
      );
    });
  }

  /** Re-activates an inactive version after re-running every validation for its future part. */
  async activate(actor: Principal, tenant: TenantContext, scheduleId: string, meta: RequestMeta) {
    const pre = await this.loadSchedule(this.deps.db, tenant, scheduleId);
    const bt = await authorizeBranch(
      this.deps,
      actor,
      tenant,
      pre.branchId,
      'clinic.schedules.manage',
    );
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, bt.clinicId);
      const s = await this.loadSchedule(tx, bt, scheduleId);
      if (s.status !== 'INACTIVE') throw new ConflictError('The schedule is already active');
      const branch = await loadBranch(tx, bt, s.branchId);
      const today = localDate(branch.timeZone, this.deps.clock().getTime());
      if (s.until !== null && s.until < today)
        throw new ConflictError('The schedule ended in the past; create a new one instead');
      const range = clip({ from: s.from, until: s.until }, today);
      if (s.ownerType === 'BRANCH') {
        const current = await this.schedules(tx, bt, {
          branchId: s.branchId,
          ownerType: 'BRANCH',
          status: 'ACTIVE',
        });
        assertNoOwnOverlap(current, range);
      } else {
        const a = await loadAssignment(tx, bt, s.assignmentId ?? '', true);
        assertConfigurable(a, this.deps.clock());
        const own = await this.schedules(tx, bt, {
          assignmentId: a.id,
          ownerType: 'DOCTOR',
          status: 'ACTIVE',
        });
        assertNoOwnOverlap(own, range);
        await this.assertDoctorScheduleValid(tx, bt, a, { ...s, status: 'ACTIVE' }, today);
      }
      await tenantExecutor(tx, bt.scope).execute(
        `UPDATE schedules SET status = 'ACTIVE', deactivated_at = NULL, deactivated_by_user_id = NULL, deactivation_reason = NULL
          WHERE id = ? AND clinic_id = ?`,
        [s.id, bt.clinicId],
      );
      return this.audited(
        tx,
        bt,
        actor,
        s.id,
        'SCHEDULE_CHANGED',
        { from: 'INACTIVE', to: 'ACTIVE', previousDeactivationReason: s.deactivationReason },
        meta,
      );
    });
  }

  // =====================================================================================
  // Exceptions
  // =====================================================================================

  async createException(
    actor: Principal,
    tenant: TenantContext,
    owner: { branchId: string } | { assignmentId: string },
    input: ExceptionInput,
    meta: RequestMeta,
  ) {
    const pre =
      'assignmentId' in owner
        ? await loadAssignment(this.deps.db, tenant, owner.assignmentId)
        : null;
    const branchId = pre === null ? (owner as { branchId: string }).branchId : pre.branch_id;
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.schedules.manage');
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, bt.clinicId);
      const branch = await loadBranch(tx, bt, branchId);
      const today = localDate(branch.timeZone, this.deps.clock().getTime());
      const a = pre === null ? null : await loadAssignment(tx, bt, pre.id, true);
      if (a !== null) assertConfigurable(a, this.deps.clock());
      const x = normalizeException(input, today);
      const existing = await this.exceptions(tx, bt, {
        branchId,
        ownerType: a === null ? 'BRANCH' : 'DOCTOR',
        assignmentId: a?.id ?? null,
        from: x.startDate,
        to: x.endDate,
      });
      const clash = existing.find(
        (e) =>
          e.kind === x.kind &&
          (x.kind === 'CLOSED' ||
            overlaps([e.start ?? 0, e.end ?? 1440], [x.start ?? 0, x.end ?? 1440])),
      );
      if (clash !== undefined)
        throw conflict('EXCEPTION_OVERLAP', 'An overlapping exception of the same kind exists', {
          exceptionId: clash.id,
        });
      if (a !== null && x.kind === 'EXTRA') {
        const range = { from: x.startDate, to: x.startDate };
        const branchDay = (await this.branchContext(tx, bt, branchId, range)).branchDay(
          x.startDate,
        );
        const outside = subtract([[x.start ?? 0, x.end ?? 0]], branchDay);
        if (outside.length > 0)
          throw conflict(
            'OUTSIDE_BRANCH_HOURS',
            'The additional period is outside the branch opening time',
            {
              date: x.startDate,
              outside: outside.map(clockRange),
            },
          );
        await this.assertNoCrossBranchConflict(tx, bt, a, {
          weekly: [],
          extras: [{ date: x.startDate, interval: [x.start ?? 0, x.end ?? 0] }],
          today,
        });
      }
      const id = String(
        (
          await tenantExecutor(tx, bt.scope).execute(
            `INSERT INTO schedule_exceptions (clinic_id, branch_id, owner_type, assignment_id, kind, start_date, end_date,
               start_minute, end_minute, reason, created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              bt.clinicId,
              branchId,
              a === null ? 'BRANCH' : 'DOCTOR',
              a?.id ?? null,
              x.kind,
              x.startDate,
              x.endDate,
              x.start,
              x.end,
              x.reason,
              actor.userId,
            ],
          )
        ).insertId,
      );
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.SCHEDULE_EXCEPTION_CHANGED,
          actor,
          tenant: bt,
          targetType: 'SCHEDULE_EXCEPTION',
          targetId: id,
          metadata: {
            branchId,
            assignmentId: a?.id ?? null,
            status: 'ACTIVE',
            kind: x.kind,
            startDate: x.startDate,
            endDate: x.endDate,
          },
          event: 'schedule_exception.created',
        },
        meta,
      );
      return exceptionView(await this.loadException(tx, bt, id));
    });
  }

  async cancelException(
    actor: Principal,
    tenant: TenantContext,
    exceptionId: string,
    meta: RequestMeta,
  ) {
    const pre = await this.loadException(this.deps.db, tenant, exceptionId);
    const bt = await authorizeBranch(
      this.deps,
      actor,
      tenant,
      pre.branchId,
      'clinic.schedules.manage',
    );
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, bt.clinicId);
      const result = await tenantExecutor(tx, bt.scope).execute(
        `UPDATE schedule_exceptions SET status = 'CANCELLED', cancelled_at = ?, cancelled_by_user_id = ?
          WHERE id = ? AND clinic_id = ? AND status = 'ACTIVE'`,
        [this.deps.clock(), actor.userId, exceptionId, bt.clinicId],
      );
      if (result.affectedRows !== 1) throw new ConflictError('The exception is already cancelled');
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.SCHEDULE_EXCEPTION_CHANGED,
          actor,
          tenant: bt,
          targetType: 'SCHEDULE_EXCEPTION',
          targetId: exceptionId,
          metadata: { branchId: pre.branchId, assignmentId: pre.assignmentId, status: 'CANCELLED' },
          event: 'schedule_exception.cancelled',
        },
        meta,
      );
      return exceptionView(await this.loadException(tx, bt, exceptionId));
    });
  }

  // =====================================================================================
  // Validation
  // =====================================================================================

  /**
   * A doctor schedule must (from today on) lie within the branch's weekly opening time: every
   * day of its range is covered by an active branch-hours version, and on every weekday that
   * occurs, the doctor's time (WORK − BREAK) is inside the branch's (OPEN − BREAK). It must also
   * not overlap, in real time, the doctor's schedules at other branches of the clinic.
   */
  private async assertDoctorScheduleValid(
    tx: SqlExecutor,
    tenant: TenantContext,
    a: AssignmentRow,
    candidate: ScheduleRecord,
    today: string,
    ignoreScheduleIds: readonly string[] = [],
  ): Promise<void> {
    const branchSchedules = await this.schedules(tx, tenant, {
      branchId: a.branch_id,
      ownerType: 'BRANCH',
      status: 'ACTIVE',
    });
    const issues = containmentIssues(candidate, branchSchedules, today);
    if (issues.gaps.length > 0)
      throw conflict(
        'BRANCH_HOURS_NOT_COVERED',
        'The branch has no opening hours for part of this range',
        {
          gaps: issues.gaps,
        },
      );
    if (issues.outside.length > 0)
      throw conflict('OUTSIDE_BRANCH_HOURS', 'The schedule is outside the branch opening hours', {
        outside: issues.outside,
      });
    await this.assertNoCrossBranchConflict(tx, tenant, a, {
      weekly: [candidate],
      extras: [],
      today,
      ignoreScheduleIds,
    });
  }

  /** Branch-hours change must keep every active doctor schedule of that branch contained. */
  private async assertDoctorsStillContained(
    tx: SqlExecutor,
    tenant: TenantContext,
    branchId: string,
    nextBranchSchedules: readonly ScheduleRecord[],
    today: string,
  ): Promise<void> {
    const doctorSchedules = await this.schedules(tx, tenant, {
      branchId,
      ownerType: 'DOCTOR',
      status: 'ACTIVE',
      onlyActiveAssignments: true,
    });
    const affected = doctorSchedules
      .filter((d) => (d.until ?? FOREVER) >= today)
      .map((d) => ({ d, issues: containmentIssues(d, nextBranchSchedules, today) }))
      .filter(({ issues }) => issues.gaps.length > 0 || issues.outside.length > 0);
    if (affected.length > 0)
      throw conflict(
        'BRANCH_HOURS_IN_USE',
        'Doctor schedules at this branch would fall outside the branch opening hours',
        {
          schedules: affected.map(({ d, issues }) => ({
            scheduleId: d.id,
            assignmentId: d.assignmentId,
            ...issues,
          })),
        },
      );
  }

  /**
   * Real-time (UTC) overlap check between the doctor's candidate time at this branch and their
   * active schedules + additional periods at the clinic's OTHER branches, each converted with
   * its own branch time zone, over CONFLICT_HORIZON_DAYS. Touching intervals are not a conflict.
   * Same-clinic only: other clinics' schedules are not visible to this clinic (see ADR-041).
   */
  private async assertNoCrossBranchConflict(
    tx: SqlExecutor,
    tenant: TenantContext,
    a: AssignmentRow,
    candidate: {
      weekly: readonly ScheduleRecord[];
      extras: readonly { date: string; interval: Interval }[];
      today: string;
      ignoreScheduleIds?: readonly string[];
    },
  ): Promise<void> {
    const others = await tenantExecutor(tx, tenant.scope).query<{
      id: string;
      branch_id: string;
      time_zone: string;
    }>(
      `SELECT a.id, a.branch_id, b.time_zone FROM doctor_branch_assignments a
         JOIN clinic_branches b ON b.id = a.branch_id AND b.clinic_id = a.clinic_id
        WHERE a.clinic_id = ? AND a.membership_id = ? AND a.status = 'ACTIVE' AND a.id <> ?`,
      [tenant.clinicId, a.membership_id, a.id],
    );
    if (others.length === 0) return;

    const starts = [
      ...candidate.weekly.map((s) => (s.from > candidate.today ? s.from : candidate.today)),
      ...candidate.extras.map((x) => x.date),
    ].sort();
    const first = starts[0];
    if (first === undefined) return;
    const horizonEnd = addDays(first, CONFLICT_HORIZON_DAYS);
    const lastCandidate = [
      ...candidate.weekly.map((s) => s.until ?? FOREVER),
      ...candidate.extras.map((x) => x.date),
    ].sort();
    const last = minDate(lastCandidate[lastCandidate.length - 1] ?? first, horizonEnd);
    const mine = expand(a.time_zone, candidate.weekly, candidate.extras, first, last);
    if (mine.length === 0) return;

    for (const o of others) {
      const range = { from: addDays(first, -1), to: addDays(last, 1) };
      const scheds = (
        await this.schedules(tx, tenant, {
          assignmentId: o.id,
          ownerType: 'DOCTOR',
          status: 'ACTIVE',
        })
      ).filter((s) => !(candidate.ignoreScheduleIds ?? []).includes(s.id));
      const extras = (
        await this.exceptions(tx, tenant, {
          branchId: o.branch_id,
          ownerType: 'DOCTOR',
          assignmentId: o.id,
          from: range.from,
          to: range.to,
        })
      )
        .filter((e) => e.kind === 'EXTRA')
        .map((e) => ({ date: e.startDate, interval: [e.start ?? 0, e.end ?? 0] as Interval }));
      const theirs = expand(o.time_zone, scheds, extras, range.from, range.to);
      const hit = firstOverlap(mine, theirs);
      if (hit !== null)
        throw conflict(
          'DOCTOR_SCHEDULE_CONFLICT',
          'The doctor is scheduled at another branch at the same time',
          {
            branchId: o.branch_id,
            assignmentId: o.id,
            startsAt: new Date(hit[0]).toISOString(),
            endsAt: new Date(hit[1]).toISOString(),
          },
        );
    }
  }

  // =====================================================================================
  // Data access
  // =====================================================================================

  private async schedules(
    executor: SqlExecutor,
    tenant: TenantContext,
    filter: ScheduleFilter,
  ): Promise<ScheduleRecord[]> {
    return loadSchedules(tenantExecutor(executor, tenant.scope), tenant.clinicId, filter);
  }

  private async withPeriods(
    t: SqlExecutor,
    tenant: TenantContext,
    rows: Row[],
  ): Promise<ScheduleRecord[]> {
    return attachPeriods(t, tenant.clinicId, rows);
  }

  private async loadSchedule(executor: SqlExecutor, tenant: TenantContext, id: string) {
    const t = tenantExecutor(executor, tenant.scope);
    const rows = await t.query<Row>(`${SCHEDULE_SELECT} WHERE s.id = ? AND s.clinic_id = ?`, [
      id,
      tenant.clinicId,
    ]);
    const [s] = await this.withPeriods(t, tenant, rows);
    if (s === undefined) throw new NotFoundError('Schedule not found');
    return s;
  }

  private async exceptions(
    executor: SqlExecutor,
    tenant: TenantContext,
    filter: {
      branchId: string;
      ownerType: OwnerType;
      assignmentId: string | null;
      from: string;
      to: string;
    },
  ): Promise<ExceptionRecord[]> {
    return loadExceptions(tenantExecutor(executor, tenant.scope), tenant.clinicId, filter);
  }

  private async loadException(executor: SqlExecutor, tenant: TenantContext, id: string) {
    const rows = await tenantExecutor(executor, tenant.scope).query<Row>(
      `${EXCEPTION_SELECT} WHERE e.id = ? AND e.clinic_id = ?`,
      [id, tenant.clinicId],
    );
    if (rows[0] === undefined) throw new NotFoundError('Exception not found');
    return toException(rows[0]);
  }

  private async branchContext(
    executor: SqlExecutor,
    tenant: TenantContext,
    branchId: string,
    range: { from: string; to: string },
  ) {
    const weekly = await this.schedules(executor, tenant, {
      branchId,
      ownerType: 'BRANCH',
      status: 'ACTIVE',
    });
    const exceptions = await this.exceptions(executor, tenant, {
      branchId,
      ownerType: 'BRANCH',
      assignmentId: null,
      ...range,
    });
    const day = resolver(weekly, exceptions);
    return { branchDay: day };
  }

  private async doctorContext(
    executor: SqlExecutor,
    tenant: TenantContext,
    assignmentId: string,
    range: { from: string; to: string },
  ) {
    const a = await loadAssignment(executor, tenant, assignmentId);
    const weekly = await this.schedules(executor, tenant, {
      assignmentId,
      ownerType: 'DOCTOR',
      status: 'ACTIVE',
    });
    const exceptions = await this.exceptions(executor, tenant, {
      branchId: a.branch_id,
      ownerType: 'DOCTOR',
      assignmentId,
      ...range,
    });
    return { day: resolver(weekly, exceptions) };
  }

  private async insertSchedule(
    tx: SqlExecutor,
    tenant: TenantContext,
    branchId: string,
    ownerType: OwnerType,
    assignmentId: string | null,
    input: ScheduleInput,
    range: DateRange,
    revision: number,
    supersedes: string | null,
    actor: Principal,
  ): Promise<string> {
    const t = tenantExecutor(tx, tenant.scope);
    const id = String(
      (
        await t.execute(
          `INSERT INTO schedules (clinic_id, branch_id, owner_type, assignment_id, effective_from, effective_until, revision,
             supersedes_schedule_id, note, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tenant.clinicId,
            branchId,
            ownerType,
            assignmentId,
            range.from,
            range.until,
            revision,
            supersedes,
            input.note ?? null,
            actor.userId,
          ],
        )
      ).insertId,
    );
    for (const p of input.periods)
      await t.execute(
        'INSERT INTO schedule_periods (clinic_id, schedule_id, day_of_week, kind, start_minute, end_minute) VALUES (?, ?, ?, ?, ?, ?)',
        [tenant.clinicId, id, p.day, p.kind, p.start, p.end],
      );
    return id;
  }

  private async audited(
    tx: SqlExecutor,
    tenant: TenantContext,
    actor: Principal,
    scheduleId: string,
    action: 'SCHEDULE_CREATED' | 'SCHEDULE_CHANGED',
    metadata: Record<string, unknown>,
    meta: RequestMeta,
  ) {
    const s = await this.loadSchedule(tx, tenant, scheduleId);
    await recordChange(
      this.deps,
      tx,
      {
        action: AUDIT_ACTION[action],
        actor,
        tenant,
        targetType: 'SCHEDULE',
        targetId: s.id,
        metadata: {
          scheduleId: s.id,
          branchId: s.branchId,
          status: s.status,
          effectiveFrom: s.from,
          effectiveUntil: s.until,
          revision: s.revision,
          periods: scheduleView(s).periods,
          ...metadata,
        },
        event: action === 'SCHEDULE_CREATED' ? 'schedule.created' : 'schedule.changed',
      },
      meta,
    );
    return scheduleView(s);
  }
}

// =========================================================================================
// Pure helpers (exported for unit tests)
// =========================================================================================

function twice<T>(v: T): [T, T] {
  return [v, v];
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function clip(range: DateRange, today: string): DateRange {
  return { from: range.from > today ? range.from : today, until: range.until };
}

function clockRange([s, e]: Interval) {
  return { start: formatClock(s), end: formatClock(e) };
}

function draft(
  branchId: string,
  ownerType: OwnerType,
  assignmentId: string | null,
  range: DateRange,
  periods: readonly Period[],
): ScheduleRecord {
  return {
    id: 'new',
    branchId,
    ownerType,
    assignmentId,
    status: 'ACTIVE',
    from: range.from,
    until: range.until,
    revision: 0,
    supersedesScheduleId: null,
    note: null,
    periods,
    createdAt: new Date(0),
    deactivatedAt: null,
    deactivationReason: null,
  };
}

function checkInput(input: ScheduleInput, today: string): DateRange {
  const issues = validatePeriods(input.periods).map((i) => ({ location: 'body', ...i }));
  if (input.effectiveFrom < today)
    issues.push({
      location: 'body',
      path: 'effectiveFrom',
      message: `must be today (${today}) or later`,
    });
  if (
    input.effectiveUntil !== undefined &&
    input.effectiveUntil !== null &&
    input.effectiveUntil < input.effectiveFrom
  )
    issues.push({
      location: 'body',
      path: 'effectiveUntil',
      message: 'must not be before effectiveFrom',
    });
  if (issues.length > 0) throw new ValidationError(issues);
  return { from: input.effectiveFrom, until: input.effectiveUntil ?? null };
}

function assertNoOwnOverlap(active: readonly ScheduleRecord[], range: DateRange): void {
  const clash = active.find((s) => rangesOverlap(s, range));
  if (clash !== undefined)
    throw conflict('SCHEDULE_OVERLAP', 'Another active schedule covers part of this date range', {
      scheduleId: clash.id,
      effectiveFrom: clash.from,
      effectiveUntil: clash.until,
    });
}

/** Weekdays that occur in an inclusive date range (all 7 when it is a week or longer). */
function weekdaysIn(range: DateRange): number[] {
  const until = range.until ?? FOREVER;
  const len = until === FOREVER ? 7 : daysBetween(range.from, until) + 1;
  if (len >= 7) return [1, 2, 3, 4, 5, 6, 7];
  return Array.from({ length: len }, (_, i) => isoWeekday(addDays(range.from, i)));
}

export function containmentIssues(
  doctor: ScheduleRecord,
  branchSchedules: readonly ScheduleRecord[],
  today: string,
) {
  const range = clip(doctor, today);
  if (range.until !== null && range.until < range.from) return { gaps: [], outside: [] };
  const overlapping = branchSchedules.filter((b) => rangesOverlap(b, range));
  const gaps = uncoveredRanges(
    range,
    overlapping,
    (d) => addDays(d, 1),
    (d) => addDays(d, -1),
  ).map((g) => ({ from: g.from, until: g.until }));
  const doctorWeek = weeklyAvailability(doctor.periods);
  const outside: { day: string; branchScheduleId: string; start: string; end: string }[] = [];
  for (const b of overlapping) {
    const both: DateRange = {
      from: b.from > range.from ? b.from : range.from,
      until: minDate(b.until ?? FOREVER, range.until ?? FOREVER),
    };
    const branchWeek = weeklyAvailability(b.periods);
    for (const day of weekdaysIn({
      from: both.from,
      until: both.until === FOREVER ? null : both.until,
    }))
      for (const iv of subtract(doctorWeek[day] ?? [], branchWeek[day] ?? []))
        outside.push({ day: dayName(day), branchScheduleId: b.id, ...clockRange(iv) });
  }
  return { gaps, outside };
}

/** Weekly versions + additional periods → real UTC intervals for local dates from..to. */
function expand(
  timeZone: string,
  weekly: readonly ScheduleRecord[],
  extras: readonly { date: string; interval: Interval }[],
  from: string,
  to: string,
): [number, number][] {
  const out: [number, number][] = [];
  const weeks = new Map(weekly.map((s) => [s.id, weeklyAvailability(s.periods)]));
  for (const date of eachDate(from, to)) {
    const s = scheduleOn(weekly, date);
    const base = s === undefined ? [] : (weeks.get(s.id)?.[isoWeekday(date)] ?? []);
    const day = merge([...base, ...extras.filter((x) => x.date === date).map((x) => x.interval)]);
    for (const [a, b] of day) {
      const utc = localRangeToUtc(timeZone, date, a, b);
      if (utc !== null) out.push([utc.start, utc.end]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function firstOverlap(
  a: readonly [number, number][],
  b: readonly [number, number][],
): [number, number] | null {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x === undefined || y === undefined) break;
    if (x[0] < y[1] && y[0] < x[1]) return [Math.max(x[0], y[0]), Math.min(x[1], y[1])];
    if (x[1] <= y[1]) i++;
    else j++;
  }
  return null;
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function assertQueryRange(range: { from: string; to: string }) {
  if (range.to < range.from || daysBetween(range.from, range.to) + 1 > MAX_WORKING_TIME_DAYS)
    throw new ValidationError([
      {
        location: 'query',
        path: 'to',
        message: `must be on or after from, at most ${MAX_WORKING_TIME_DAYS} days`,
      },
    ]);
}

function dayView(timeZone: string, date: string, intervals: readonly Interval[]) {
  const utc = intervals
    .map(([s, e]) => localRangeToUtc(timeZone, date, s, e))
    .filter((x): x is { start: number; end: number } => x !== null);
  return {
    date,
    local: intervals.map(clockRange),
    utc: utc.map((x) => ({
      startsAt: new Date(x.start).toISOString(),
      endsAt: new Date(x.end).toISOString(),
    })),
  };
}

function normalizeException(input: ExceptionInput, today: string) {
  const issues: { location: string; path: string; message: string }[] = [];
  const endDate = input.kind === 'CLOSED' ? (input.endDate ?? input.startDate) : input.startDate;
  if (input.startDate < today)
    issues.push({
      location: 'body',
      path: 'startDate',
      message: `must be today (${today}) or later`,
    });
  if (input.kind === 'CLOSED') {
    if (input.start !== undefined || input.end !== undefined)
      issues.push({
        location: 'body',
        path: 'start',
        message: 'CLOSED covers whole days; omit start/end',
      });
    if (endDate < input.startDate)
      issues.push({ location: 'body', path: 'endDate', message: 'must not be before startDate' });
    else if (daysBetween(input.startDate, endDate) + 1 > MAX_CLOSED_DAYS)
      issues.push({
        location: 'body',
        path: 'endDate',
        message: `at most ${MAX_CLOSED_DAYS} days`,
      });
  } else {
    if (input.endDate !== undefined && input.endDate !== input.startDate)
      issues.push({
        location: 'body',
        path: 'endDate',
        message: `${input.kind} applies to one date`,
      });
    if (input.start === undefined || input.end === undefined || input.start >= input.end)
      issues.push({
        location: 'body',
        path: 'start',
        message: 'start and end are required, start before end',
      });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return {
    kind: input.kind,
    startDate: input.startDate,
    endDate,
    start: input.kind === 'CLOSED' ? null : (input.start ?? null),
    end: input.kind === 'CLOSED' ? null : (input.end ?? null),
    reason: input.reason,
  };
}
