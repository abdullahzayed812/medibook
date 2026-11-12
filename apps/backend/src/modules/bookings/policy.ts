import { defineStateMachine } from '../../shared/state-machine.js';
import { localRangeToUtc, localTime } from '../clinic-setup/time-zone.js';
import { formatClock, type Interval } from '../clinic-setup/weekly.js';

/** Pure booking rules (no I/O; unit-tested). See docs/platform/BOOKINGS.md. */

export const BOOKING_STATUSES = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'REJECTED',
  'CHECKED_IN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'RESCHEDULED',
  'EXPIRED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type BookingMode = 'SLOT' | 'QUEUE';
export type ActorKind = 'SELF' | 'DELEGATE' | 'GUEST' | 'STAFF' | 'SYSTEM';

/**
 * The approved lifecycle. Task 05 performs the PENDING_CONFIRMATION and CONFIRMED → CANCELLED /
 * RESCHEDULED transitions; CHECKED_IN, IN_PROGRESS, COMPLETED and NO_SHOW are reached only by
 * Task 06/clinical workflows (no Task 05 endpoint performs them).
 */
export const BOOKING_LIFECYCLE = defineStateMachine<BookingStatus>('Booking', {
  PENDING_CONFIRMATION: ['CONFIRMED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED', 'RESCHEDULED', 'CHECKED_IN', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  RESCHEDULED: [],
  COMPLETED: [],
  NO_SHOW: [],
});

/** Statuses that occupy the doctor's and the patient's time. */
export const OCCUPYING_STATUSES: readonly BookingStatus[] = [
  'CONFIRMED',
  'CHECKED_IN',
  'IN_PROGRESS',
];

/**
 * SQL predicate (alias `b`) for "this booking holds its time right now": occupying statuses, or a
 * pending request whose confirmation deadline has not passed. Binds one parameter: now.
 * Because the deadline is part of the predicate, an expired hold stops counting at its deadline
 * even if the expiration worker never runs.
 */
export const HOLDS_TIME_SQL = `(b.status IN ('CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS')
  OR (b.status = 'PENDING_CONFIRMATION' AND b.confirmation_deadline > ?))`;

// ---------- clinic booking settings (platform limits) ----------

export const BOOKING_LIMITS = {
  slotIntervalMinutes: { min: 5, max: 120 },
  minLeadMinutes: { min: 0, max: 10_080 },
  maxHorizonDays: { min: 1, max: 180 },
  confirmationTtlMinutes: { min: 5, max: 2_880 },
  cancelMinNoticeMinutes: { min: 0, max: 10_080 },
} as const;

export interface BookingSettings {
  readonly slotEnabled: boolean;
  readonly queueEnabled: boolean;
  readonly slotIntervalMinutes: number;
  readonly minLeadMinutes: number;
  readonly maxHorizonDays: number;
  readonly confirmationTtlMinutes: number;
  readonly cancelMinNoticeMinutes: number;
  readonly cancelReasonRequired: boolean;
}

export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  slotEnabled: true,
  queueEnabled: false,
  slotIntervalMinutes: 15,
  minLeadMinutes: 60,
  maxHorizonDays: 60,
  confirmationTtlMinutes: 120,
  cancelMinNoticeMinutes: 1440,
  cancelReasonRequired: false,
};

/** Snapshotted on every booking; later setting changes never alter it. */
export interface CancellationPolicy {
  readonly minNoticeMinutes: number;
  readonly reasonRequired: boolean;
}

export function cancellationPolicyOf(s: BookingSettings): CancellationPolicy {
  return { minNoticeMinutes: s.cancelMinNoticeMinutes, reasonRequired: s.cancelReasonRequired };
}

export type CancellationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: 'REASON_REQUIRED' | 'NOTICE_PERIOD_PASSED';
      readonly cancelUntil?: Date;
    };

/**
 * Patient cancellation under the snapshotted policy. A request that is still pending can always
 * be withdrawn. A confirmed booking needs `minNoticeMinutes` before its start (and a reason if
 * the policy requires one). Clinic cancellation is not limited by this policy (reason required).
 */
export function evaluatePatientCancellation(input: {
  status: BookingStatus;
  startsAt: Date;
  policy: CancellationPolicy;
  reason: string | null;
  now: Date;
}): CancellationDecision {
  if (input.status === 'PENDING_CONFIRMATION') return { allowed: true };
  if (input.policy.reasonRequired && (input.reason ?? '').trim().length < 3)
    return { allowed: false, code: 'REASON_REQUIRED' };
  const cancelUntil = new Date(input.startsAt.getTime() - input.policy.minNoticeMinutes * 60_000);
  if (input.now.getTime() > cancelUntil.getTime())
    return { allowed: false, code: 'NOTICE_PERIOD_PASSED', cancelUntil };
  return { allowed: true };
}

/** Confirmation deadline: TTL from now, never later than the appointment start. */
export function confirmationDeadline(now: Date, startsAt: Date, ttlMinutes: number): Date {
  return new Date(Math.min(now.getTime() + ttlMinutes * 60_000, startsAt.getTime()));
}

// ---------- slot generation ----------

export interface Slot {
  readonly startsAt: number;
  readonly endsAt: number;
  /** End of the doctor's blocked time (appointment + buffer). */
  readonly blockEndsAt: number;
  readonly localDate: string;
  readonly localStart: string;
  readonly localEnd: string;
}

/**
 * Appointment slots of ONE doctor assignment for one service, from resolved working time
 * (Task 04: doctor ∩ branch, breaks, exceptions, effective dates, local minutes per local date).
 *
 *  - Candidates start at each working interval's start and step by `intervalMinutes`.
 *  - The appointment AND its buffer must fit inside the working interval: a slot never crosses
 *    a break, a closure, leave or the end of the day.
 *  - Converted with the branch zone using the Task 04 DST rule. A slot whose real UTC length is
 *    not exactly `durationMinutes` (it touches a DST gap or overlap) is not offered: no
 *    appointment ever silently becomes shorter or longer than the service.
 *  - Lead time and booking horizon are applied to the real start instant.
 *  - Slots whose blocked interval overlaps a `busy` interval (the doctor's occupying bookings
 *    and live holds in ANY clinic, plus excluded patient conflicts) are removed.
 */
export function generateSlots(input: {
  timeZone: string;
  dates: readonly string[];
  working: (date: string) => readonly Interval[];
  durationMinutes: number;
  bufferMinutes: number;
  intervalMinutes: number;
  now: Date;
  minLeadMinutes: number;
  maxHorizonDays: number;
  /** Doctor's blocked intervals (any clinic): compared with appointment + buffer. */
  busy: readonly (readonly [number, number])[];
  /** The patient's own appointments: compared with the appointment itself. */
  personBusy?: readonly (readonly [number, number])[];
}): Slot[] {
  const earliest = input.now.getTime() + input.minLeadMinutes * 60_000;
  const latest = input.now.getTime() + input.maxHorizonDays * 86_400_000;
  const length = input.durationMinutes * 60_000;
  const out: Slot[] = [];
  for (const date of input.dates) {
    for (const [a, b] of input.working(date)) {
      for (
        let t = a;
        t + input.durationMinutes + input.bufferMinutes <= b;
        t += input.intervalMinutes
      ) {
        const utc = localRangeToUtc(input.timeZone, date, t, t + input.durationMinutes);
        if (utc === null || utc.end - utc.start !== length) continue;
        if (localTime(input.timeZone, utc.start).date !== date) continue;
        if (utc.start < earliest || utc.start > latest) continue;
        const blockEnd = utc.end + input.bufferMinutes * 60_000;
        if (input.busy.some(([s, e]) => s < blockEnd && e > utc.start)) continue;
        if ((input.personBusy ?? []).some(([s, e]) => s < utc.end && e > utc.start)) continue;
        out.push({
          startsAt: utc.start,
          endsAt: utc.end,
          blockEndsAt: blockEnd,
          localDate: date,
          localStart: formatClock(t),
          localEnd: formatClock(t + input.durationMinutes),
        });
      }
    }
  }
  return out;
}
