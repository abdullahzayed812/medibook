/**
 * Wall-clock ↔ UTC conversion for IANA time zones, using the runtime's ICU data (Intl). No
 * extra dependency. Recurring schedules are stored as LOCAL wall-clock minutes in the branch's
 * time zone and are converted per concrete date, so a 09:00 period stays 09:00 local across
 * daylight-saving changes.
 *
 * DST rule (one rule for both cases; see docs/platform/SCHEDULES.md):
 *   A local wall time w on date D maps to the FIRST instant at which the local clock on D reads
 *   a time ≥ w.
 *   - Ambiguous (clocks fall back; w happens twice): the first occurrence.
 *   - Nonexistent (clocks spring forward; w is skipped): the transition instant, i.e. the
 *     moment the clock jumps past w.
 *   A period [s, e) therefore becomes the single UTC interval [map(s), map(e)). It is clipped,
 *   never shifted into an unintended time, and a period lying wholly inside a gap is empty.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function parts(timeZone: string, ms: number): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** UTC offset of `timeZone` at instant `ms`, in whole minutes (local = UTC + offset). */
export function offsetMinutes(timeZone: string, ms: number): number {
  const p = parts(timeZone, ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}

/** Local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDate(timeZone: string, ms: number): string {
  const p = parts(timeZone, ms);
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local wall-clock reading of an instant: date plus minutes since local midnight. */
export function localTime(timeZone: string, ms: number): { date: string; minute: number } {
  const p = parts(timeZone, ms);
  return {
    date: `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`,
    minute: p.hour * 60 + p.minute,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Midnight of a calendar date as if it were UTC (date arithmetic only, no zone). */
export function dateToUtcMidnight(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number): string {
  return new Date(dateToUtcMidnight(date) + days * DAY).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(dateToUtcMidnight(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Inclusive number of days from `from` to `to` (0 when equal). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateToUtcMidnight(to) - dateToUtcMidnight(from)) / DAY);
}

export type WallTimeKind = 'UNIQUE' | 'AMBIGUOUS' | 'NONEXISTENT';

/**
 * Maps local wall time `minute` (0..1440; 1440 = midnight ending the day) on `date` to an
 * instant using the module's DST rule, and says which case applied.
 */
export function wallTimeToInstant(
  timeZone: string,
  date: string,
  minute: number,
): { ms: number; kind: WallTimeKind } {
  const local = dateToUtcMidnight(date) + minute * MINUTE;
  // At most one transition lies within ±30 h of any instant for real-world zones.
  const before = offsetMinutes(timeZone, local - 30 * 60 * MINUTE);
  const after = offsetMinutes(timeZone, local + 30 * 60 * MINUTE);
  const valid = [...new Set([before, after])]
    .map((o) => local - o * MINUTE)
    .filter((t) => offsetMinutes(timeZone, t) * MINUTE === local - t)
    .sort((a, b) => a - b);
  const first = valid[0];
  if (first !== undefined) {
    return { ms: first, kind: valid.length > 1 ? 'AMBIGUOUS' : 'UNIQUE' };
  }
  // Gap (spring forward): the transition lies in [local - after, local - before]. Find the first
  // instant whose offset is already `after`, to the minute (transitions fall on whole minutes).
  let lo = local - after * MINUTE;
  let hi = local - before * MINUTE;
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / MINUTE / 2) * MINUTE;
    if (offsetMinutes(timeZone, mid) === after) hi = mid;
    else lo = mid;
  }
  return { ms: offsetMinutes(timeZone, lo) === after ? lo : hi, kind: 'NONEXISTENT' };
}

/** A local [start, end) minute range on `date` as a UTC interval, or null when it is empty. */
export function localRangeToUtc(
  timeZone: string,
  date: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const s = wallTimeToInstant(timeZone, date, start).ms;
  const e = wallTimeToInstant(timeZone, date, end).ms;
  return e > s ? { start: s, end: e } : null;
}
