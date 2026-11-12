/**
 * Pure weekly-schedule rules (no I/O; unit-tested). Times are local wall-clock minutes from
 * midnight (0..1440). A period never crosses midnight: an overnight shift is two periods
 * (e.g. MON 22:00–24:00 + TUE 00:00–02:00), which is unambiguous to validate and to convert.
 */

export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type DayName = (typeof DAYS)[number];
export type PeriodKind = 'WORK' | 'BREAK';

export interface Period {
  readonly day: number; // ISO 1 = Monday … 7 = Sunday
  readonly kind: PeriodKind;
  readonly start: number;
  readonly end: number;
}

/** Half-open minute interval [start, end). */
export type Interval = readonly [number, number];

export const MAX_PERIODS = 70;

export interface Issue {
  readonly path: string;
  readonly message: string;
}

export function dayNumber(day: DayName): number {
  return DAYS.indexOf(day) + 1;
}

export function dayName(day: number): DayName {
  const name = DAYS[day - 1];
  if (name === undefined) throw new RangeError(`day must be 1..7, got ${String(day)}`);
  return name;
}

/** "HH:MM" (00:00–24:00) → minutes; undefined when malformed. */
export function parseClock(value: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/.exec(value);
  if (m === null) return undefined;
  return value === '24:00' ? 1440 : Number(m[1]) * 60 + Number(m[2]);
}

export function formatClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Sorts and merges overlapping or touching intervals. */
export function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function subtract(base: readonly Interval[], minus: readonly Interval[]): Interval[] {
  let result = merge(base);
  for (const [ms, me] of merge(minus)) {
    const next: Interval[] = [];
    for (const [s, e] of result) {
      if (me <= s || ms >= e) next.push([s, e]);
      else {
        if (ms > s) next.push([s, ms]);
        if (me < e) next.push([me, e]);
      }
    }
    result = next;
  }
  return result;
}

export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [as, ae] of merge(a))
    for (const [bs, be] of merge(b)) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (e > s) out.push([s, e]);
    }
  return merge(out);
}

/** True when two half-open intervals share time (touching is not an overlap). */
export function overlaps(a: Interval, b: Interval): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * Structural rules for one schedule version:
 *  - start < end, within the day (24:00 allowed as an end);
 *  - WORK periods on the same day do not overlap;
 *  - every BREAK lies inside one WORK period of the same day, and breaks do not overlap;
 *  - at least one WORK period; at most MAX_PERIODS periods.
 */
export function validatePeriods(periods: readonly Period[]): Issue[] {
  const issues: Issue[] = [];
  if (periods.length === 0) issues.push({ path: 'periods', message: 'at least one period' });
  if (periods.length > MAX_PERIODS)
    issues.push({ path: 'periods', message: `at most ${MAX_PERIODS} periods` });
  periods.forEach((p, i) => {
    if (!(p.start >= 0 && p.end <= 1440 && p.start < p.end))
      issues.push({ path: `periods.${i}`, message: 'start must be before end within one day' });
  });
  if (!periods.some((p) => p.kind === 'WORK'))
    issues.push({ path: 'periods', message: 'at least one WORK period' });
  if (issues.length > 0) return issues;

  for (let day = 1; day <= 7; day++) {
    const indexed = periods.map((p, i) => ({ p, i })).filter(({ p }) => p.day === day);
    const work = indexed.filter(({ p }) => p.kind === 'WORK');
    const breaks = indexed.filter(({ p }) => p.kind === 'BREAK');
    for (const group of [work, breaks])
      for (let a = 0; a < group.length; a++)
        for (let b = a + 1; b < group.length; b++) {
          const x = group[a];
          const y = group[b];
          if (x && y && overlaps([x.p.start, x.p.end], [y.p.start, y.p.end]))
            issues.push({
              path: `periods.${y.i}`,
              message: `overlaps periods.${x.i} on ${dayName(day)}`,
            });
        }
    for (const { p, i } of breaks)
      if (!work.some(({ p: w }) => w.start <= p.start && p.end <= w.end))
        issues.push({
          path: `periods.${i}`,
          message: 'a BREAK must lie inside a WORK period of the same day',
        });
  }
  return issues;
}

/** Available time per weekday (index 1..7): WORK minus BREAK, merged. */
export function weeklyAvailability(periods: readonly Period[]): Interval[][] {
  const week: Interval[][] = [[], [], [], [], [], [], [], []];
  for (let day = 1; day <= 7; day++) {
    const on = periods.filter((p) => p.day === day);
    week[day] = subtract(
      on.filter((p) => p.kind === 'WORK').map((p) => [p.start, p.end] as Interval),
      on.filter((p) => p.kind === 'BREAK').map((p) => [p.start, p.end] as Interval),
    );
  }
  return week;
}

export interface DayException {
  readonly kind: 'CLOSED' | 'UNAVAILABLE' | 'EXTRA';
  readonly start: number | null;
  readonly end: number | null;
}

/**
 * Resolves one date: CLOSED → nothing at all (also drops EXTRA); otherwise
 * (weekly − UNAVAILABLE) ∪ EXTRA. A day with different hours is expressed as an UNAVAILABLE
 * covering the regular hours plus EXTRA periods for the new ones.
 */
export function resolveDay(
  base: readonly Interval[],
  exceptions: readonly DayException[],
): Interval[] {
  if (exceptions.some((x) => x.kind === 'CLOSED')) return [];
  const range = (kind: DayException['kind']) =>
    exceptions
      .filter((x) => x.kind === kind && x.start !== null && x.end !== null)
      .map((x) => [x.start, x.end] as Interval);
  return merge([...subtract(base, range('UNAVAILABLE')), ...range('EXTRA')]);
}

// ---------- effective date ranges (inclusive local dates; null = open-ended) ----------

export const FOREVER = '9999-12-31';

export interface DateRange {
  readonly from: string;
  readonly until: string | null;
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.from <= (b.until ?? FOREVER) && b.from <= (a.until ?? FOREVER);
}

/** Parts of `target` not covered by the union of `cover` (all inclusive date ranges). */
export function uncoveredRanges(
  target: DateRange,
  cover: readonly DateRange[],
  nextDay: (date: string) => string,
  prevDay: (date: string) => string,
): DateRange[] {
  const end = target.until ?? FOREVER;
  const sorted = [...cover].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const gaps: DateRange[] = [];
  let cursor = target.from;
  for (const c of sorted) {
    const cEnd = c.until ?? FOREVER;
    if (cEnd < cursor) continue;
    if (c.from > end) break;
    if (c.from > cursor) gaps.push({ from: cursor, until: prevDay(c.from) });
    if (cEnd >= end) return gaps;
    cursor = nextDay(cEnd);
  }
  if (cursor <= end) gaps.push({ from: cursor, until: target.until });
  return gaps;
}
