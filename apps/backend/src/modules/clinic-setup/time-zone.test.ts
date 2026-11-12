import { describe, expect, it } from 'vitest';
import {
  addDays,
  isoWeekday,
  isValidTimeZone,
  localDate,
  localRangeToUtc,
  offsetMinutes,
  wallTimeToInstant,
} from './time-zone.js';

const iso = (ms: number) => new Date(ms).toISOString();
const NY = 'America/New_York';
const CAIRO = 'Africa/Cairo';

describe('time zones', () => {
  it('validates IANA identifiers', () => {
    expect(isValidTimeZone('Africa/Cairo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('computes offsets on both sides of a transition', () => {
    expect(offsetMinutes(NY, Date.parse('2026-03-08T06:59:00Z'))).toBe(-300);
    expect(offsetMinutes(NY, Date.parse('2026-03-08T07:00:00Z'))).toBe(-240);
    expect(offsetMinutes(CAIRO, Date.parse('2026-01-15T12:00:00Z'))).toBe(120);
    expect(offsetMinutes(CAIRO, Date.parse('2026-07-15T12:00:00Z'))).toBe(180);
    expect(offsetMinutes('Asia/Kolkata', Date.parse('2026-07-15T12:00:00Z'))).toBe(330);
  });

  it('date helpers use the ISO week (1 = Monday … 7 = Sunday)', () => {
    expect(isoWeekday('2026-11-09')).toBe(1);
    expect(isoWeekday('2026-11-15')).toBe(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(localDate(CAIRO, Date.parse('2026-11-11T22:30:00Z'))).toBe('2026-11-12');
  });

  it('maps ordinary wall times uniquely', () => {
    expect(wallTimeToInstant(NY, '2026-06-01', 9 * 60)).toEqual({
      ms: Date.parse('2026-06-01T13:00:00Z'),
      kind: 'UNIQUE',
    });
    // 24:00 is the first instant of the next local day.
    expect(iso(wallTimeToInstant(CAIRO, '2026-01-15', 1440).ms)).toBe('2026-01-15T22:00:00.000Z');
  });

  it('nonexistent times (spring forward) map to the transition instant', () => {
    // New York 2026-03-08: 02:00 EST → 03:00 EDT; 02:00–02:59 do not exist.
    const r = wallTimeToInstant(NY, '2026-03-08', 2 * 60 + 30);
    expect(r.kind).toBe('NONEXISTENT');
    expect(iso(r.ms)).toBe('2026-03-08T07:00:00.000Z');
    // Cairo 2026-04-24 (last Friday of April): 00:00 → 01:00.
    const c = wallTimeToInstant(CAIRO, '2026-04-24', 30);
    expect(c.kind).toBe('NONEXISTENT');
    expect(iso(c.ms)).toBe('2026-04-23T22:00:00.000Z');
  });

  it('ambiguous times (fall back) map to the first occurrence', () => {
    // New York 2026-11-01: 02:00 EDT → 01:00 EST; 01:00–01:59 happen twice.
    const r = wallTimeToInstant(NY, '2026-11-01', 90);
    expect(r.kind).toBe('AMBIGUOUS');
    expect(iso(r.ms)).toBe('2026-11-01T05:30:00.000Z');
    // Cairo 2026-10-29 (last Thursday of October): 24:00 → 23:00; 23:00–23:59 happen twice.
    const c = wallTimeToInstant(CAIRO, '2026-10-29', 23 * 60 + 15);
    expect(c.kind).toBe('AMBIGUOUS');
    expect(iso(c.ms)).toBe('2026-10-29T20:15:00.000Z');
  });

  it('periods across transitions are clipped, never shifted', () => {
    // 01:00–04:00 on the spring-forward day: 2 real hours.
    expect(localRangeToUtc(NY, '2026-03-08', 60, 240)).toEqual({
      start: Date.parse('2026-03-08T06:00:00Z'),
      end: Date.parse('2026-03-08T08:00:00Z'),
    });
    // Starting inside the gap: begins when the clock jumps (03:00 EDT).
    expect(iso(localRangeToUtc(NY, '2026-03-08', 150, 240)?.start ?? 0)).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    // Wholly inside the gap: empty.
    expect(localRangeToUtc(NY, '2026-03-08', 120, 165)).toBeNull();
    // 00:00–03:00 on the fall-back day: from the first 00:00 to 03:00 EST = 4 real hours.
    const fall = localRangeToUtc(NY, '2026-11-01', 0, 180);
    expect(((fall?.end ?? 0) - (fall?.start ?? 0)) / 3_600_000).toBe(4);
    // 01:00–01:30 on the fall-back day: first occurrence only (30 minutes, never 90).
    const inOverlap = localRangeToUtc(NY, '2026-11-01', 60, 90);
    expect(((inOverlap?.end ?? 0) - (inOverlap?.start ?? 0)) / 60_000).toBe(30);
  });
});
