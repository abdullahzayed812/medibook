import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error.js';
import type { Clock } from '../../shared/security/clock.js';
import {
  ASSIGNMENT_SELECT,
  assignmentBlockers,
  type AssignmentRow,
} from '../clinic-setup/context.js';
import { workingTime } from '../clinic-setup/schedule-data.js';
import { addDays, daysBetween, localDate } from '../clinic-setup/time-zone.js';
import type { Interval } from '../clinic-setup/weekly.js';
import type { ClinicOperationGateImpl } from '../clinics/operation-gate.js';
import {
  DEFAULT_BOOKING_SETTINGS,
  generateSlots,
  HOLDS_TIME_SQL,
  type BookingMode,
  type BookingSettings,
  type Slot,
} from './policy.js';

/**
 * Availability (ADR-044). Slots are COMPUTED from authoritative Task 04 data plus persisted
 * bookings on every request; nothing about future slots is stored or cached, so there is no
 * second source of truth to invalidate. Booking creation re-runs the same computation inside its
 * transaction, so a client's earlier availability answer is never trusted.
 *
 * Every query filters by the clinic being booked (explicit `clinic_id = ?`). The only global
 * reads are the doctor's and the patient's busy intervals (start/end instants only — no clinic,
 * patient, service or status details leave the query).
 */

export const MAX_AVAILABILITY_DAYS = 14;
const MAX_SLOTS = 2000;

type Row = Record<string, unknown>;

export interface Candidate {
  readonly clinicId: string;
  readonly branchId: string;
  readonly timeZone: string;
  readonly settings: BookingSettings;
  readonly assignment: AssignmentRow;
  readonly offeringId: string;
  readonly serviceId: string;
  readonly serviceNameEn: string | null;
  readonly serviceNameAr: string | null;
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly priceMinor: number;
  readonly currency: string;
}

export async function loadSettings(
  executor: SqlExecutor,
  clinicId: string,
): Promise<BookingSettings> {
  const row = (
    await executor.query<Row>('SELECT * FROM clinic_booking_settings WHERE clinic_id = ?', [
      clinicId,
    ])
  )[0];
  if (row === undefined) return DEFAULT_BOOKING_SETTINGS;
  return {
    slotEnabled: Number(row.slot_enabled) === 1,
    queueEnabled: Number(row.queue_enabled) === 1,
    slotIntervalMinutes: Number(row.slot_interval_minutes),
    minLeadMinutes: Number(row.min_lead_minutes),
    maxHorizonDays: Number(row.max_horizon_days),
    confirmationTtlMinutes: Number(row.confirmation_ttl_minutes),
    cancelMinNoticeMinutes: Number(row.cancel_min_notice_minutes),
    cancelReasonRequired: Number(row.cancel_reason_required) === 1,
  };
}

/** The branch's offering of the service: 404 unless branch, offering and service exist and are active. */
async function loadOffering(
  executor: SqlExecutor,
  clinicId: string,
  branchId: string,
  serviceId: string,
) {
  const row = (
    await executor.query<Row>(
      `SELECT o.id, o.price_minor, o.currency, o.duration_minutes, o.buffer_minutes, s.name_en, s.name_ar,
              b.time_zone, b.status AS branch_status
         FROM branch_service_offerings o
         JOIN clinic_services s ON s.id = o.service_id AND s.clinic_id = o.clinic_id
         JOIN clinic_branches b ON b.id = o.branch_id AND b.clinic_id = o.clinic_id
        WHERE o.clinic_id = ? AND o.branch_id = ? AND o.service_id = ? AND o.status = 'ACTIVE' AND s.status = 'ACTIVE'`,
      [clinicId, branchId, serviceId],
    )
  )[0];
  if (row === undefined) throw new NotFoundError('The service is not offered at this branch');
  return row;
}

/**
 * Eligible doctors for (branch, service): an ACTIVE doctor-service assignment, an EFFECTIVE
 * doctor branch assignment (membership, coverage, verification, branch — Task 04 blockers).
 */
export async function loadCandidates(
  executor: SqlExecutor,
  clock: Clock,
  input: {
    clinicId: string;
    branchId: string;
    serviceId: string;
    assignmentId?: string | undefined;
  },
): Promise<Candidate[]> {
  const offering = await loadOffering(executor, input.clinicId, input.branchId, input.serviceId);
  const settings = await loadSettings(executor, input.clinicId);
  const ds = await executor.query<{
    assignment_id: string;
    duration_minutes: number | null;
    price_minor: string | null;
  }>(
    `SELECT assignment_id, duration_minutes, price_minor FROM doctor_service_assignments
      WHERE clinic_id = ? AND branch_id = ? AND offering_id = ? AND status = 'ACTIVE' AND (? IS NULL OR assignment_id = ?)`,
    [
      input.clinicId,
      input.branchId,
      String(offering.id),
      input.assignmentId ?? null,
      input.assignmentId ?? null,
    ],
  );
  if (ds.length === 0) return [];
  const assignments = await executor.query<AssignmentRow>(
    `${ASSIGNMENT_SELECT} WHERE a.clinic_id = ? AND a.id IN (${ds.map(() => '?').join(', ')})`,
    [input.clinicId, ...ds.map((d) => d.assignment_id)],
  );
  const now = clock();
  return assignments
    .filter((a) => assignmentBlockers(a, now).length === 0)
    .map((a) => {
      const d = ds.find((x) => x.assignment_id === a.id);
      return {
        clinicId: input.clinicId,
        branchId: input.branchId,
        timeZone: offering.time_zone as string,
        settings,
        assignment: a,
        offeringId: String(offering.id),
        serviceId: input.serviceId,
        serviceNameEn: (offering.name_en as string | null) ?? null,
        serviceNameAr: (offering.name_ar as string | null) ?? null,
        durationMinutes: Number(d?.duration_minutes ?? offering.duration_minutes),
        bufferMinutes: Number(offering.buffer_minutes),
        priceMinor: Number(d?.price_minor ?? offering.price_minor),
        currency: offering.currency as string,
      };
    });
}

/** The doctor's occupied time in ANY clinic (global key: doctor profile), as instants only. */
export async function doctorBusy(
  executor: SqlExecutor,
  doctorProfileId: string,
  window: { from: number; to: number },
  now: Date,
  excludeIds: readonly string[] = [],
): Promise<[number, number][]> {
  const rows = await executor.query<{ starts_at: Date; block_ends_at: Date }>(
    `SELECT b.starts_at, b.block_ends_at FROM bookings b
      WHERE b.doctor_profile_id = ? AND b.mode = 'SLOT' AND b.starts_at < ? AND b.block_ends_at > ?
        AND ${HOLDS_TIME_SQL} ${excludeIds.length > 0 ? `AND b.id NOT IN (${excludeIds.map(() => '?').join(', ')})` : ''}`,
    [doctorProfileId, new Date(window.to), new Date(window.from), now, ...excludeIds],
  );
  return rows.map((r) => [r.starts_at.getTime(), r.block_ends_at.getTime()]);
}

/**
 * The patient's appointments in ANY clinic, by CANONICAL identity (ADR-055): every booking person
 * linked to the same identity counts. Instants only — nothing else leaves the query.
 */
export async function identityBusy(
  executor: SqlExecutor,
  identityId: string,
  window: { from: number; to: number },
  now: Date,
  excludeIds: readonly string[] = [],
): Promise<[number, number][]> {
  const rows = await executor.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT b.starts_at, b.ends_at FROM bookings b JOIN booking_persons bp ON bp.id = b.person_id
      WHERE bp.identity_id = ? AND b.mode = 'SLOT' AND b.starts_at < ? AND b.ends_at > ?
        AND ${HOLDS_TIME_SQL} ${excludeIds.length > 0 ? `AND b.id NOT IN (${excludeIds.map(() => '?').join(', ')})` : ''}`,
    [identityId, new Date(window.to), new Date(window.from), now, ...excludeIds],
  );
  return rows.map((r) => [r.starts_at.getTime(), r.ends_at.getTime()]);
}

function dates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Slots of one candidate for local dates, after doctor (global) and optional patient conflicts. */
export async function slotsFor(
  executor: SqlExecutor,
  candidate: Candidate,
  range: { from: string; to: string },
  now: Date,
  options: {
    identityId?: string | undefined;
    excludeIds?: readonly string[];
    ignoreLeadAndHorizon?: boolean;
  } = {},
): Promise<Slot[]> {
  const working = await workingTime(
    executor,
    candidate.clinicId,
    candidate.branchId,
    candidate.assignment.id,
    range,
  );
  const window = {
    from: Date.parse(`${addDays(range.from, -1)}T00:00:00Z`),
    to: Date.parse(`${addDays(range.to, 2)}T00:00:00Z`),
  };
  const busy = await doctorBusy(
    executor,
    candidate.assignment.doctor_profile_id,
    window,
    now,
    options.excludeIds,
  );
  const mine =
    options.identityId === undefined
      ? []
      : await identityBusy(executor, options.identityId, window, now, options.excludeIds);
  return generateSlots({
    timeZone: candidate.timeZone,
    dates: dates(range.from, range.to),
    working,
    durationMinutes: candidate.durationMinutes,
    bufferMinutes: candidate.bufferMinutes,
    intervalMinutes: candidate.settings.slotIntervalMinutes,
    now,
    minLeadMinutes: options.ignoreLeadAndHorizon === true ? 0 : candidate.settings.minLeadMinutes,
    maxHorizonDays:
      options.ignoreLeadAndHorizon === true ? 100_000 : candidate.settings.maxHorizonDays,
    busy,
    personBusy: mine,
  });
}

/** True when [start, blockEnd) lies inside the candidate's resolved working time on its local date. */
export async function fitsWorkingTime(
  executor: SqlExecutor,
  candidate: Candidate,
  startsAt: Date,
  blockEndsAt: Date,
): Promise<boolean> {
  const date = localDate(candidate.timeZone, startsAt.getTime());
  const working = await workingTime(
    executor,
    candidate.clinicId,
    candidate.branchId,
    candidate.assignment.id,
    {
      from: date,
      to: date,
    },
  );
  // Re-generate the day with a 1-minute step and no conflicts: the interval must be one of them.
  const slots = generateSlots({
    timeZone: candidate.timeZone,
    dates: [date],
    working,
    durationMinutes: Math.round((blockEndsAt.getTime() - startsAt.getTime()) / 60_000),
    bufferMinutes: 0,
    intervalMinutes: 1,
    now: new Date(0),
    minLeadMinutes: 0,
    maxHorizonDays: 1_000_000,
    busy: [],
  });
  return slots.some((s) => s.startsAt === startsAt.getTime());
}

export interface AvailabilityQuery {
  readonly clinicId: string;
  readonly branchId: string;
  readonly serviceId: string;
  readonly assignmentId?: string | undefined;
  readonly from: string;
  readonly to: string;
  readonly mode: BookingMode;
  readonly personId?: string | undefined;
}

export class AvailabilityService {
  constructor(
    private readonly deps: { db: Database; gate: ClinicOperationGateImpl; clock: Clock },
  ) {}

  /** Bookable slots only. Returns `available: false` with a generic reason when not bookable. */
  async query(q: AvailabilityQuery) {
    if (q.mode === 'QUEUE')
      throw new AppError(422, 'BOOKING_MODE_NOT_SUPPORTED', 'Queue bookings are not available yet');
    if (q.to < q.from || daysBetween(q.from, q.to) + 1 > MAX_AVAILABILITY_DAYS)
      throw new ValidationError([
        {
          location: 'query',
          path: 'to',
          message: `must be on or after from, at most ${MAX_AVAILABILITY_DAYS} days`,
        },
      ]);
    const db = this.deps.db;
    const branch = (
      await db.query<{ time_zone: string }>(
        'SELECT time_zone FROM clinic_branches WHERE clinic_id = ? AND id = ?',
        [q.clinicId, q.branchId],
      )
    )[0];
    if (branch === undefined) throw new NotFoundError('Branch not found');
    const empty = (reason: string) => ({
      clinicId: q.clinicId,
      branchId: q.branchId,
      serviceId: q.serviceId,
      mode: q.mode,
      timeZone: branch.time_zone,
      available: false,
      reason,
      slots: [],
    });
    const candidates = await loadCandidates(db, this.deps.clock, q);
    const settings = await loadSettings(db, q.clinicId);
    if (!settings.slotEnabled) return empty('SLOT_BOOKING_DISABLED');
    const gate = await this.deps.gate.evaluate({
      clinicId: q.clinicId,
      branchId: q.branchId,
      userId: '0',
      category: 'NEW_OPERATION',
    });
    // Generic on purpose: suspension, closure and subscription details stay internal.
    if (!gate.allowed) return empty('NOT_ACCEPTING_BOOKINGS');
    const now = this.deps.clock();
    const identityId =
      q.personId === undefined
        ? undefined
        : (
            await db.query<{ identity_id: string }>(
              'SELECT identity_id FROM booking_persons WHERE id = ?',
              [q.personId],
            )
          )[0]?.identity_id;
    const slots = [];
    for (const c of candidates) {
      for (const s of await slotsFor(db, c, q, now, { identityId })) {
        slots.push({
          assignmentId: c.assignment.id,
          doctor: { displayName: c.assignment.display_name },
          startsAt: new Date(s.startsAt).toISOString(),
          endsAt: new Date(s.endsAt).toISOString(),
          local: { date: s.localDate, start: s.localStart, end: s.localEnd },
          durationMinutes: c.durationMinutes,
          price: { amountMinor: c.priceMinor, currency: c.currency },
        });
        if (slots.length >= MAX_SLOTS) break;
      }
    }
    slots.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
    return {
      clinicId: q.clinicId,
      branchId: q.branchId,
      serviceId: q.serviceId,
      mode: q.mode,
      timeZone: branch.time_zone,
      available: slots.length > 0,
      reason: slots.length > 0 ? null : 'NO_SLOTS',
      slots,
    };
  }
}

export type { Interval };
