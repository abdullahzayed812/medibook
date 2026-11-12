import type { SqlExecutor } from '../../infrastructure/database/database.js';
import { isoWeekday } from './time-zone.js';
import {
  FOREVER,
  intersect,
  resolveDay,
  weeklyAvailability,
  type DayException,
  type Interval,
  type Period,
} from './weekly.js';

/**
 * Schedule data access and day resolution shared by the clinic-setup API (inside a verified
 * TenantContext, through tenantExecutor) and the Booking Engine (system reads for one clinic).
 * Every statement filters by `clinic_id = ?`; callers pass the clinic they are entitled to.
 */

export type OwnerType = 'BRANCH' | 'DOCTOR';
export type ExceptionKind = 'CLOSED' | 'UNAVAILABLE' | 'EXTRA';

export interface ScheduleRecord {
  readonly id: string;
  readonly branchId: string;
  readonly ownerType: OwnerType;
  readonly assignmentId: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly from: string;
  readonly until: string | null;
  readonly revision: number;
  readonly supersedesScheduleId: string | null;
  readonly note: string | null;
  readonly periods: readonly Period[];
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
  readonly deactivationReason: string | null;
}

export interface ExceptionRecord {
  readonly id: string;
  readonly branchId: string;
  readonly ownerType: OwnerType;
  readonly assignmentId: string | null;
  readonly kind: ExceptionKind;
  readonly startDate: string;
  readonly endDate: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly reason: string;
  readonly status: 'ACTIVE' | 'CANCELLED';
  readonly createdAt: Date;
  readonly cancelledAt: Date | null;
}

type Row = Record<string, unknown>;

const twice = <T>(v: T): [T, T] => [v, v];

export const SCHEDULE_SELECT = `
  SELECT s.id, s.branch_id, s.owner_type, s.assignment_id, s.status,
         DATE_FORMAT(s.effective_from, '%Y-%m-%d') AS eff_from,
         DATE_FORMAT(s.effective_until, '%Y-%m-%d') AS eff_until,
         s.revision, s.supersedes_schedule_id, s.note, s.created_at, s.deactivated_at, s.deactivation_reason
    FROM schedules s`;

export const EXCEPTION_SELECT = `
  SELECT e.id, e.branch_id, e.owner_type, e.assignment_id, e.kind,
         DATE_FORMAT(e.start_date, '%Y-%m-%d') AS s_date, DATE_FORMAT(e.end_date, '%Y-%m-%d') AS e_date,
         e.start_minute, e.end_minute, e.reason, e.status, e.created_at, e.cancelled_at
    FROM schedule_exceptions e`;

export const toException = (r: Row): ExceptionRecord => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  ownerType: r.owner_type as OwnerType,
  assignmentId: (r.assignment_id as string | null) ?? null,
  kind: r.kind as ExceptionKind,
  startDate: r.s_date as string,
  endDate: r.e_date as string,
  start: r.start_minute === null ? null : Number(r.start_minute),
  end: r.end_minute === null ? null : Number(r.end_minute),
  reason: r.reason as string,
  status: r.status as 'ACTIVE' | 'CANCELLED',
  createdAt: r.created_at as Date,
  cancelledAt: (r.cancelled_at as Date | null) ?? null,
});

export interface ScheduleFilter {
  branchId?: string;
  assignmentId?: string;
  ownerType: OwnerType;
  status?: 'ACTIVE' | 'INACTIVE' | undefined;
  onlyActiveAssignments?: boolean;
  cursor?: string | undefined;
  limit?: number;
}

export async function loadSchedules(
  executor: SqlExecutor,
  clinicId: string,
  filter: ScheduleFilter,
): Promise<ScheduleRecord[]> {
  const rows = await executor.query<Row>(
    `${SCHEDULE_SELECT}
      ${filter.onlyActiveAssignments === true ? `JOIN doctor_branch_assignments a ON a.id = s.assignment_id AND a.clinic_id = s.clinic_id AND a.status = 'ACTIVE'` : ''}
      WHERE s.clinic_id = ? AND s.owner_type = ? AND (? IS NULL OR s.branch_id = ?)
        AND (? IS NULL OR s.assignment_id = ?) AND (? IS NULL OR s.status = ?) AND (? IS NULL OR s.id < ?)
      ORDER BY s.id DESC LIMIT ?`,
    [
      clinicId,
      filter.ownerType,
      ...twice(filter.branchId ?? null),
      ...twice(filter.assignmentId ?? null),
      ...twice(filter.status ?? null),
      ...twice(filter.cursor ?? null),
      filter.limit ?? 1000,
    ],
  );
  return attachPeriods(executor, clinicId, rows);
}

export async function attachPeriods(
  executor: SqlExecutor,
  clinicId: string,
  rows: Row[],
): Promise<ScheduleRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id));
  const periods = await executor.query<Row>(
    `SELECT schedule_id, day_of_week, kind, start_minute, end_minute FROM schedule_periods
      WHERE clinic_id = ? AND schedule_id IN (${ids.map(() => '?').join(', ')})`,
    [clinicId, ...ids],
  );
  const by = new Map<string, Period[]>();
  for (const p of periods) {
    const list = by.get(String(p.schedule_id)) ?? [];
    list.push({
      day: Number(p.day_of_week),
      kind: p.kind as Period['kind'],
      start: Number(p.start_minute),
      end: Number(p.end_minute),
    });
    by.set(String(p.schedule_id), list);
  }
  return rows.map((r) => ({
    id: String(r.id),
    branchId: String(r.branch_id),
    ownerType: r.owner_type as OwnerType,
    assignmentId: (r.assignment_id as string | null) ?? null,
    status: r.status as 'ACTIVE' | 'INACTIVE',
    from: r.eff_from as string,
    until: (r.eff_until as string | null) ?? null,
    revision: Number(r.revision),
    supersedesScheduleId: (r.supersedes_schedule_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    periods: by.get(String(r.id)) ?? [],
    createdAt: r.created_at as Date,
    deactivatedAt: (r.deactivated_at as Date | null) ?? null,
    deactivationReason: (r.deactivation_reason as string | null) ?? null,
  }));
}

export async function loadExceptions(
  executor: SqlExecutor,
  clinicId: string,
  filter: {
    branchId: string;
    ownerType: OwnerType;
    assignmentId: string | null;
    from: string;
    to: string;
  },
): Promise<ExceptionRecord[]> {
  const rows = await executor.query<Row>(
    `${EXCEPTION_SELECT} WHERE e.clinic_id = ? AND e.branch_id = ? AND e.owner_type = ? AND e.status = 'ACTIVE'
        AND (? IS NULL OR e.assignment_id = ?) AND e.end_date >= ? AND e.start_date <= ?`,
    [
      clinicId,
      filter.branchId,
      filter.ownerType,
      ...twice(filter.assignmentId),
      filter.from,
      filter.to,
    ],
  );
  return rows.map(toException);
}

export function scheduleOn(
  schedules: readonly ScheduleRecord[],
  date: string,
): ScheduleRecord | undefined {
  return schedules.find((s) => s.from <= date && date <= (s.until ?? FOREVER));
}

/** Day resolver over weekly versions + dated exceptions (local minutes). */
export function dayResolver(
  weekly: readonly ScheduleRecord[],
  exceptions: readonly ExceptionRecord[],
): (date: string) => Interval[] {
  const cache = new Map<string, Interval[][]>();
  return (date: string): Interval[] => {
    const s = scheduleOn(weekly, date);
    let base: Interval[] = [];
    if (s !== undefined) {
      let week = cache.get(s.id);
      if (week === undefined) {
        week = weeklyAvailability(s.periods);
        cache.set(s.id, week);
      }
      base = week[isoWeekday(date)] ?? [];
    }
    const todays: DayException[] = exceptions.filter(
      (e) => e.startDate <= date && date <= e.endDate,
    );
    return resolveDay(base, todays);
  };
}

/**
 * Resolved working time of one doctor assignment at its branch (doctor ∩ branch, local minutes
 * per local date) — the same rule as `GET …/working-time` (SCHEDULES.md). Eligibility of the
 * assignment is the caller's responsibility.
 */
export async function workingTime(
  executor: SqlExecutor,
  clinicId: string,
  branchId: string,
  assignmentId: string,
  range: { from: string; to: string },
): Promise<(date: string) => Interval[]> {
  const [branchWeekly, branchExceptions, doctorWeekly, doctorExceptions] = await Promise.all([
    loadSchedules(executor, clinicId, { branchId, ownerType: 'BRANCH', status: 'ACTIVE' }),
    loadExceptions(executor, clinicId, {
      branchId,
      ownerType: 'BRANCH',
      assignmentId: null,
      ...range,
    }),
    loadSchedules(executor, clinicId, { assignmentId, ownerType: 'DOCTOR', status: 'ACTIVE' }),
    loadExceptions(executor, clinicId, { branchId, ownerType: 'DOCTOR', assignmentId, ...range }),
  ]);
  const branchDay = dayResolver(branchWeekly, branchExceptions);
  const doctorDay = dayResolver(doctorWeekly, doctorExceptions);
  return (date) => intersect(doctorDay(date), branchDay(date));
}
