import { addDays, localDate, offsetMinutes } from '../../../src/modules/clinic-setup/time-zone.js';
import type { Harness } from './harness.js';
import { testPhone, type LoggedIn } from './fixtures.js';
import { addStaff, as, data, userSession, type OnboardedClinic } from './platform.js';

/** Task 04 helpers: verified doctors, branches, schedules. Synthetic data only. */

export interface Doctor {
  readonly session: LoggedIn;
  readonly phone: string;
  readonly membershipId: string;
}

/** A user with a VERIFIED global doctor profile and a DOCTOR membership in the clinic. */
export async function verifiedDoctor(
  h: Harness,
  c: OnboardedClinic,
  options: {
    branchScope?: 'ALL' | 'ASSIGNED';
    branchIds?: string[];
    verification?: string;
    member?: { session: LoggedIn; phone: string };
  } = {},
): Promise<Doctor> {
  const phone = options.member?.phone ?? testPhone();
  const session = options.member?.session ?? (await userSession(h, phone));
  if (options.member === undefined)
    await h.db.execute(
      'INSERT INTO doctor_profiles (user_id, display_name, verification_status) VALUES (?, ?, ?)',
      [session.userId, 'Dr. Synthetic Example', options.verification ?? 'VERIFIED'],
    );
  const staff = await addStaff(h, c.owner, c.clinicId, 'DOCTOR', {
    member: { session, phone },
    ...(options.branchScope === undefined ? {} : { branchScope: options.branchScope }),
    ...(options.branchIds === undefined ? {} : { branchIds: options.branchIds }),
  });
  return { session, phone, membershipId: staff.membershipId };
}

export const api = (h: Harness, s: LoggedIn, c: OnboardedClinic) =>
  as(h, s, { clinicId: c.clinicId });

export async function addBranch(
  h: Harness,
  c: OnboardedClinic,
  name: string,
  timeZone = 'Africa/Cairo',
): Promise<string> {
  const res = await api(h, c.owner, c).post('/clinic/branches', { name, timeZone });
  if (res.status !== 201)
    throw new Error(`branch failed ${res.status} ${JSON.stringify(res.body)}`);
  return data<{ id: string }>(res).id;
}

export async function setBranchTimeZone(
  h: Harness,
  c: OnboardedClinic,
  branchId: string,
  timeZone: string,
): Promise<void> {
  const res = await api(h, c.owner, c).patch(`/clinic/branches/${branchId}`, { timeZone });
  if (res.status !== 200) throw new Error(`tz failed ${res.status} ${JSON.stringify(res.body)}`);
}

export async function assign(
  h: Harness,
  c: OnboardedClinic,
  branchId: string,
  membershipId: string,
): Promise<string> {
  const res = await api(h, c.owner, c).post(`/clinic/branches/${branchId}/doctors`, {
    membershipId,
  });
  if (res.status !== 201)
    throw new Error(`assign failed ${res.status} ${JSON.stringify(res.body)}`);
  return data<{ id: string }>(res).id;
}

const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/** The same period(s) on every listed day (default: all days). */
export function every(
  start: string,
  end: string,
  options: { days?: readonly string[]; breaks?: [string, string][] } = {},
) {
  return (options.days ?? ALL_DAYS).flatMap((day) => [
    { day, start, end },
    ...(options.breaks ?? []).map(([s, e]) => ({ day, kind: 'BREAK', start: s, end: e })),
  ]);
}

export function today(h: Harness, timeZone = 'Africa/Cairo'): string {
  return localDate(timeZone, h.clock().getTime());
}

export async function branchHours(
  h: Harness,
  c: OnboardedClinic,
  branchId: string,
  body: object,
): Promise<{ status: number; body: unknown }> {
  return api(h, c.owner, c).post(`/clinic/branches/${branchId}/hours`, body);
}

export async function doctorSchedule(
  h: Harness,
  c: OnboardedClinic,
  assignmentId: string,
  body: object,
): Promise<{ status: number; body: unknown }> {
  return api(h, c.owner, c).post(`/clinic/doctor-assignments/${assignmentId}/schedules`, body);
}

/** First local date on/after `from` whose UTC offset differs from the previous day's (a DST change). */
export function nextTransitionDate(
  timeZone: string,
  from: string,
  direction: 'forward' | 'back',
): string {
  for (let d = from, i = 0; i < 800; i++, d = addDays(d, 1)) {
    const noon = (date: string) => Date.parse(`${date}T12:00:00Z`);
    const before = offsetMinutes(timeZone, noon(addDays(d, -1)));
    const after = offsetMinutes(timeZone, noon(d));
    if (direction === 'forward' ? after > before : after < before) return d;
  }
  throw new Error('no transition found');
}
