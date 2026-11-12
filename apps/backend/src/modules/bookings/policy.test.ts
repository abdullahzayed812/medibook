import { describe, expect, it } from 'vitest';
import {
  BOOKING_LIFECYCLE,
  confirmationDeadline,
  evaluatePatientCancellation,
  generateSlots,
  type BookingStatus,
} from './policy.js';

const at = (iso: string) => Date.parse(iso);
const base = {
  timeZone: 'UTC',
  durationMinutes: 30,
  bufferMinutes: 0,
  intervalMinutes: 30,
  now: new Date('2027-01-01T00:00:00Z'),
  minLeadMinutes: 0,
  maxHorizonDays: 60,
  busy: [] as [number, number][],
};
const starts = (slots: { localStart: string }[]) => slots.map((s) => s.localStart);

describe('booking lifecycle', () => {
  it('allows only the approved transitions', () => {
    const ok: [BookingStatus, BookingStatus][] = [
      ['PENDING_CONFIRMATION', 'CONFIRMED'],
      ['PENDING_CONFIRMATION', 'REJECTED'],
      ['PENDING_CONFIRMATION', 'EXPIRED'],
      ['PENDING_CONFIRMATION', 'CANCELLED'],
      ['CONFIRMED', 'CANCELLED'],
      ['CONFIRMED', 'RESCHEDULED'],
    ];
    for (const [f, t] of ok) expect(BOOKING_LIFECYCLE.can(f, t), `${f}→${t}`).toBe(true);
    const bad: [BookingStatus, BookingStatus][] = [
      ['EXPIRED', 'CONFIRMED'],
      ['REJECTED', 'CONFIRMED'],
      ['CANCELLED', 'CONFIRMED'],
      ['PENDING_CONFIRMATION', 'RESCHEDULED'],
      ['CONFIRMED', 'EXPIRED'],
      ['RESCHEDULED', 'CONFIRMED'],
      ['CONFIRMED', 'PENDING_CONFIRMATION'],
    ];
    for (const [f, t] of bad) expect(BOOKING_LIFECYCLE.can(f, t), `${f}→${t}`).toBe(false);
    expect(() => {
      BOOKING_LIFECYCLE.assert('EXPIRED', 'CONFIRMED');
    }).toThrow(/cannot change/);
  });
});

describe('cancellation policy', () => {
  const policy = { minNoticeMinutes: 1440, reasonRequired: true };
  const startsAt = new Date('2027-01-10T10:00:00Z');
  it('pending requests can always be withdrawn', () => {
    expect(
      evaluatePatientCancellation({
        status: 'PENDING_CONFIRMATION',
        startsAt,
        policy,
        reason: null,
        now: new Date('2027-01-10T09:59:00Z'),
      }),
    ).toEqual({ allowed: true });
  });
  it('confirmed bookings need notice and (if required) a reason', () => {
    const now = new Date('2027-01-08T10:00:00Z');
    expect(
      evaluatePatientCancellation({ status: 'CONFIRMED', startsAt, policy, reason: 'Travel', now }),
    ).toEqual({ allowed: true });
    expect(
      evaluatePatientCancellation({ status: 'CONFIRMED', startsAt, policy, reason: null, now }),
    ).toMatchObject({
      allowed: false,
      code: 'REASON_REQUIRED',
    });
    expect(
      evaluatePatientCancellation({
        status: 'CONFIRMED',
        startsAt,
        policy,
        reason: 'Travel',
        now: new Date('2027-01-09T10:00:01Z'),
      }),
    ).toMatchObject({ allowed: false, code: 'NOTICE_PERIOD_PASSED' });
  });
  it('confirmation deadline never passes the appointment start', () => {
    const now = new Date('2027-01-10T09:00:00Z');
    expect(confirmationDeadline(now, startsAt, 120).toISOString()).toBe('2027-01-10T10:00:00.000Z');
    expect(confirmationDeadline(now, startsAt, 30).toISOString()).toBe('2027-01-10T09:30:00.000Z');
  });
});

describe('generateSlots', () => {
  it('uses the service duration, steps by the interval and respects breaks (split working time)', () => {
    const slots = generateSlots({
      ...base,
      dates: ['2027-01-04'],
      working: () => [
        [540, 660],
        [690, 780],
      ], // 09:00–11:00, (break) 11:30–13:00
      durationMinutes: 45,
      intervalMinutes: 15,
    });
    // 45-min slots must end by 11:00 (last start 10:15) and by 13:00 (last start 12:15).
    expect(starts(slots)).toEqual([
      '09:00',
      '09:15',
      '09:30',
      '09:45',
      '10:00',
      '10:15',
      '11:30',
      '11:45',
      '12:00',
      '12:15',
    ]);
    expect(slots.every((s) => s.endsAt - s.startsAt === 45 * 60_000)).toBe(true);
  });

  it('keeps the buffer inside working time and blocks it', () => {
    const slots = generateSlots({
      ...base,
      dates: ['2027-01-04'],
      working: () => [[540, 600]],
      bufferMinutes: 10,
    });
    expect(starts(slots)).toEqual(['09:00']);
    expect(slots[0]?.blockEndsAt).toBe(at('2027-01-04T09:40:00Z'));
  });

  it('removes slots overlapping busy doctor time (buffer included) and patient time', () => {
    const working = () => [[540, 720]] as [number, number][];
    const busy: [number, number][] = [[at('2027-01-04T10:00:00Z'), at('2027-01-04T10:30:00Z')]];
    expect(starts(generateSlots({ ...base, dates: ['2027-01-04'], working, busy }))).toEqual([
      '09:00',
      '09:30',
      '10:30',
      '11:00',
      '11:30',
    ]);
    expect(
      starts(generateSlots({ ...base, dates: ['2027-01-04'], working, busy, bufferMinutes: 5 })),
    ).toEqual(['09:00', '10:30', '11:00']);
    expect(
      starts(generateSlots({ ...base, dates: ['2027-01-04'], working, personBusy: busy })),
    ).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('applies lead time and horizon to the real start', () => {
    const now = new Date('2027-01-04T09:10:00Z');
    expect(
      starts(
        generateSlots({
          ...base,
          now,
          minLeadMinutes: 60,
          dates: ['2027-01-04'],
          working: () => [[540, 720]],
        }),
      ),
    ).toEqual(['10:30', '11:00', '11:30']);
    expect(
      generateSlots({
        ...base,
        maxHorizonDays: 1,
        dates: ['2027-01-04'],
        working: () => [[540, 720]],
      }),
    ).toEqual([]);
  });

  it('converts with the branch zone and never offers slots with a wrong real length across DST', () => {
    const ny = {
      ...base,
      timeZone: 'America/New_York',
      now: new Date('2027-01-01T00:00:00Z'),
      maxHorizonDays: 400,
    };
    // Spring forward 2027-03-14: 02:00–02:59 do not exist. 01:30–02:00 is a real 30 minutes
    // (it ends when the clock jumps); 02:00/02:30 starts do not exist and are not offered.
    const spring = generateSlots({ ...ny, dates: ['2027-03-14'], working: () => [[60, 240]] });
    expect(starts(spring)).toEqual(['01:00', '01:30', '03:00', '03:30']);
    expect(spring[0]?.startsAt).toBe(at('2027-03-14T06:00:00Z'));
    // Fall back 2027-11-07: 01:00–01:59 happen twice. 01:30–02:00 would be 90 real minutes.
    const fall = generateSlots({ ...ny, dates: ['2027-11-07'], working: () => [[0, 180]] });
    expect(starts(fall)).toEqual(['00:00', '00:30', '01:00', '02:00', '02:30']);
    expect(fall.find((s) => s.localStart === '01:00')?.startsAt).toBe(at('2027-11-07T05:00:00Z')); // first 01:00 (EDT)
    expect(fall.every((s) => s.endsAt - s.startsAt === 30 * 60_000)).toBe(true);
  });
});
