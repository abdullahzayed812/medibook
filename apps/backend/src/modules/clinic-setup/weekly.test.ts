import { describe, expect, it } from 'vitest';
import { addDays } from './time-zone.js';
import {
  formatClock,
  intersect,
  merge,
  parseClock,
  rangesOverlap,
  resolveDay,
  subtract,
  uncoveredRanges,
  validatePeriods,
  weeklyAvailability,
  type Period,
} from './weekly.js';

const w = (day: number, start: string, end: string, kind: Period['kind'] = 'WORK'): Period => ({
  day,
  kind,
  start: parseClock(start) ?? -1,
  end: parseClock(end) ?? -1,
});

describe('clock parsing', () => {
  it('accepts 00:00–24:00 and rejects everything else', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    for (const bad of ['24:01', '25:00', '9:30', '09:60', '0930', ''])
      expect(parseClock(bad)).toBeUndefined();
    expect(formatClock(1440)).toBe('24:00');
  });
});

describe('interval arithmetic', () => {
  it('merges, subtracts and intersects', () => {
    expect(
      merge([
        [60, 120],
        [100, 200],
        [200, 210],
        [300, 400],
      ]),
    ).toEqual([
      [60, 210],
      [300, 400],
    ]);
    expect(
      subtract(
        [[0, 100]],
        [
          [20, 30],
          [50, 60],
        ],
      ),
    ).toEqual([
      [0, 20],
      [30, 50],
      [60, 100],
    ]);
    expect(
      intersect(
        [[0, 100]],
        [
          [50, 150],
          [10, 20],
        ],
      ),
    ).toEqual([
      [10, 20],
      [50, 100],
    ]);
  });
});

describe('validatePeriods', () => {
  it('accepts several periods per day with breaks inside work', () => {
    expect(
      validatePeriods([
        w(1, '09:00', '13:00'),
        w(1, '11:00', '11:30', 'BREAK'),
        w(1, '16:00', '20:00'),
        w(2, '22:00', '24:00'),
        w(3, '00:00', '02:00'),
      ]),
    ).toEqual([]);
  });

  it('rejects inverted, overlapping, orphan-break and empty schedules', () => {
    expect(validatePeriods([w(1, '10:00', '09:00')])[0]?.message).toMatch(/before end/);
    expect(validatePeriods([w(1, '09:00', '12:00'), w(1, '11:00', '14:00')])[0]?.message).toMatch(
      /overlaps/,
    );
    expect(
      validatePeriods([w(1, '09:00', '12:00'), w(1, '12:30', '13:00', 'BREAK')])[0]?.message,
    ).toMatch(/inside a WORK/);
    expect(
      validatePeriods([
        w(1, '09:00', '17:00'),
        w(1, '12:00', '13:00', 'BREAK'),
        w(1, '12:30', '13:30', 'BREAK'),
      ])[0]?.message,
    ).toMatch(/overlaps/);
    expect(validatePeriods([])).not.toEqual([]);
    expect(validatePeriods([w(1, '12:00', '13:00', 'BREAK')])).not.toEqual([]);
    // Touching periods are allowed (e.g. split shifts handled by two rows).
    expect(validatePeriods([w(1, '09:00', '12:00'), w(1, '12:00', '14:00')])).toEqual([]);
  });

  it('computes weekly availability as work minus breaks', () => {
    const week = weeklyAvailability([w(1, '09:00', '17:00'), w(1, '12:00', '13:00', 'BREAK')]);
    expect(week[1]).toEqual([
      [540, 720],
      [780, 1020],
    ]);
    expect(week[2]).toEqual([]);
  });
});

describe('resolveDay', () => {
  const base: [number, number][] = [[540, 1020]];
  it('CLOSED wins over everything; UNAVAILABLE removes; EXTRA adds', () => {
    expect(
      resolveDay(base, [
        { kind: 'CLOSED', start: null, end: null },
        { kind: 'EXTRA', start: 0, end: 60 },
      ]),
    ).toEqual([]);
    expect(resolveDay(base, [{ kind: 'UNAVAILABLE', start: 600, end: 660 }])).toEqual([
      [540, 600],
      [660, 1020],
    ]);
    expect(resolveDay(base, [{ kind: 'EXTRA', start: 1080, end: 1200 }])).toEqual([
      [540, 1020],
      [1080, 1200],
    ]);
    // Different hours for one day: remove the regular hours, add the new ones.
    expect(
      resolveDay(base, [
        { kind: 'UNAVAILABLE', start: 0, end: 1440 },
        { kind: 'EXTRA', start: 600, end: 720 },
      ]),
    ).toEqual([[600, 720]]);
  });
});

describe('effective date ranges', () => {
  const next = (d: string) => addDays(d, 1);
  const prev = (d: string) => addDays(d, -1);
  it('detects overlap with inclusive bounds and open ends', () => {
    expect(
      rangesOverlap(
        { from: '2026-01-01', until: '2026-12-31' },
        { from: '2027-01-01', until: null },
      ),
    ).toBe(false);
    expect(
      rangesOverlap(
        { from: '2026-01-01', until: '2026-12-31' },
        { from: '2026-12-31', until: null },
      ),
    ).toBe(true);
    expect(
      rangesOverlap({ from: '2026-01-01', until: null }, { from: '2030-01-01', until: null }),
    ).toBe(true);
  });
  it('finds uncovered parts of a range', () => {
    expect(
      uncoveredRanges(
        { from: '2026-01-01', until: '2026-03-31' },
        [
          { from: '2026-01-01', until: '2026-01-31' },
          { from: '2026-03-01', until: null },
        ],
        next,
        prev,
      ),
    ).toEqual([{ from: '2026-02-01', until: '2026-02-28' }]);
    expect(
      uncoveredRanges(
        { from: '2026-01-01', until: null },
        [{ from: '2026-01-01', until: '2026-06-30' }],
        next,
        prev,
      ),
    ).toEqual([{ from: '2026-07-01', until: null }]);
    expect(
      uncoveredRanges(
        { from: '2026-01-01', until: null },
        [{ from: '2025-01-01', until: null }],
        next,
        prev,
      ),
    ).toEqual([]);
  });
});
