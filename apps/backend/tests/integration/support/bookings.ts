import { randomUUID } from 'node:crypto';
import { addDays } from '../../../src/modules/clinic-setup/time-zone.js';
import type { Harness } from './harness.js';
import { testPhone, type LoggedIn } from './fixtures.js';
import { as, data, onboardClinic, userSession, type OnboardedClinic } from './platform.js';
import {
  api,
  assign,
  branchHours,
  doctorSchedule,
  every,
  setBranchTimeZone,
  today,
  verifiedDoctor,
  type Doctor,
} from './setup.js';

/** Task 05 helpers. Synthetic data only. */

export interface BookableClinic {
  readonly c: OnboardedClinic;
  readonly doctor: Doctor;
  readonly assignmentId: string;
  readonly serviceId: string;
  readonly t0: string; // branch-local today
  readonly day: string; // branch-local date used for bookings (two days ahead)
  readonly timeZone: string;
}

/**
 * A paid clinic whose main branch (Africa/Cairo unless given) is open 08:00–20:00 daily, with one
 * verified doctor working 09:00–13:00 daily, one 30-minute service (EGP 200.00) offered and
 * assigned, and booking settings: 30-minute interval, no lead time.
 */
export async function bookableClinic(
  h: Harness,
  admin: LoggedIn,
  options: {
    timeZone?: string;
    doctor?: Doctor;
    work?: [string, string];
    duration?: number;
    buffer?: number;
    settings?: object;
  } = {},
): Promise<BookableClinic> {
  const timeZone = options.timeZone ?? 'Africa/Cairo';
  const c = await onboardClinic(h, admin, { paid: true });
  await setBranchTimeZone(h, c, c.branchId, timeZone);
  const doctor =
    options.doctor === undefined
      ? await verifiedDoctor(h, c)
      : await verifiedDoctor(h, c, { member: options.doctor });
  const assignmentId = await assign(h, c, c.branchId, doctor.membershipId);
  const t0 = today(h, timeZone);
  await branchHours(h, c, c.branchId, { effectiveFrom: t0, periods: every('00:00', '24:00') });
  const [ws, we] = options.work ?? ['09:00', '13:00'];
  const sched = await doctorSchedule(h, c, assignmentId, {
    effectiveFrom: t0,
    periods: every(ws, we),
  });
  if (sched.status !== 201)
    throw new Error(`schedule ${sched.status} ${JSON.stringify(sched.body)}`);
  const o = api(h, c.owner, c);
  const serviceId = data<{ id: string }>(
    await o.post('/clinic/services', { nameEn: 'Consultation', nameAr: 'كشف' }),
  ).id;
  await o.put(`/clinic/branches/${c.branchId}/services/${serviceId}`, {
    priceMinor: 20000,
    durationMinutes: options.duration ?? 30,
    bufferMinutes: options.buffer ?? 0,
  });
  await o.put(`/clinic/doctor-assignments/${assignmentId}/services/${serviceId}`, {});
  const s = await o.put('/clinic/booking-settings', {
    slotIntervalMinutes: 30,
    minLeadMinutes: 0,
    ...options.settings,
  });
  if (s.status !== 200) throw new Error(`settings ${s.status} ${JSON.stringify(s.body)}`);
  return { c, doctor, assignmentId, serviceId, t0, day: addDays(t0, 2), timeZone };
}

export async function patient(
  h: Harness,
  phone = testPhone(),
): Promise<LoggedIn & { phone: string }> {
  const s = await userSession(h, phone, 'PATIENT_MOBILE');
  return { ...s, phone };
}

export interface Slot {
  assignmentId: string;
  startsAt: string;
  endsAt: string;
  local: { date: string; start: string; end: string };
}

export async function availability(
  h: Harness,
  b: BookableClinic,
  options: { from?: string; to?: string; as?: LoggedIn; personId?: string; extra?: string } = {},
) {
  const from = options.from ?? b.day;
  const query = `clinicId=${b.c.clinicId}&branchId=${b.c.branchId}&serviceId=${b.serviceId}&from=${from}&to=${options.to ?? from}${options.personId ? `&personId=${options.personId}` : ''}${options.extra ?? ''}`;
  const res =
    options.as === undefined
      ? await h.http().get(`/api/v1/availability?${query}`)
      : await as(h, options.as).get(`/me/availability?${query}`);
  return res;
}

export async function slots(
  h: Harness,
  b: BookableClinic,
  options: Parameters<typeof availability>[2] = {},
) {
  const res = await availability(h, b, options);
  if (res.status !== 200) throw new Error(`availability ${res.status} ${JSON.stringify(res.body)}`);
  return data<{ slots: Slot[]; available: boolean; reason: string | null }>(res);
}

/** Local start times of the available slots ("09:00", …). */
export async function startsOf(
  h: Harness,
  b: BookableClinic,
  options: Parameters<typeof availability>[2] = {},
) {
  return (await slots(h, b, options)).slots.map((s) => s.local.start);
}

export function slotBody(b: BookableClinic, slot: Slot, extra: object = {}) {
  return {
    clinicId: b.c.clinicId,
    branchId: b.c.branchId,
    serviceId: b.serviceId,
    assignmentId: slot.assignmentId,
    startsAt: slot.startsAt,
    ...extra,
  };
}

export const key = () => `k_${randomUUID().replace(/-/g, '')}`;

export function book(h: Harness, s: LoggedIn, payload: object, idem: string = key()) {
  return as(h, s).post('/me/bookings', payload).set('Idempotency-Key', idem);
}

/** Books the first slot (or the one starting at `start`) for patient `s`; returns the booking id. */
export async function bookSlot(
  h: Harness,
  b: BookableClinic,
  s: LoggedIn,
  start = '09:00',
  extra: object = {},
) {
  const slot = (await slots(h, b)).slots.find((x) => x.local.start === start);
  if (slot === undefined) throw new Error(`no slot ${start}`);
  const res = await book(h, s, slotBody(b, slot, extra));
  if (res.status !== 201) throw new Error(`book ${res.status} ${JSON.stringify(res.body)}`);
  return data<{ id: string }>(res).id;
}

export const clinic = (h: Harness, b: BookableClinic) => api(h, b.c.owner, b.c);

export async function confirm(h: Harness, b: BookableClinic, bookingId: string) {
  return clinic(h, b).post(`/clinic/bookings/${bookingId}/confirm`, {});
}

export async function statusOf(h: Harness, bookingId: string): Promise<string | undefined> {
  return (
    await h.db.query<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [bookingId])
  )[0]?.status;
}

/** Guest: OTP for a GUEST_BOOKING challenge, read from the mock outbox, exchanged for a token. */
export async function guestToken(
  h: Harness,
  phone = testPhone(),
): Promise<{ token: string; phone: string }> {
  await h.clearCooldowns();
  const req = await h.http().post('/api/v1/guest/verifications').send({ phone });
  if (req.status !== 202) throw new Error(`guest otp ${req.status} ${JSON.stringify(req.body)}`);
  const challengeId = data<{ challengeId: string }>(req).challengeId;
  const code = h.otp.lastCodeFor(phone) ?? '';
  const ver = await h
    .http()
    .post('/api/v1/guest/verifications/verify')
    .send({ challengeId, phone, code });
  if (ver.status !== 200) throw new Error(`guest verify ${ver.status} ${JSON.stringify(ver.body)}`);
  return { token: data<{ guestToken: string }>(ver).guestToken, phone };
}

/** A guest books the first slot; returns the booking id, the one-time claim code and the token. */
export async function guestBook(
  h: Harness,
  b: BookableClinic,
  options: { phone?: string; token?: string; start?: string } = {},
) {
  const g =
    options.token === undefined
      ? await guestToken(h, options.phone)
      : { token: options.token, phone: options.phone ?? '' };
  const slot = (await slots(h, b)).slots.find((x) => x.local.start === (options.start ?? '09:00'));
  if (slot === undefined) throw new Error('no slot');
  const res = await h
    .http()
    .post('/api/v1/guest/bookings')
    .set('X-Guest-Token', g.token)
    .set('Idempotency-Key', key())
    .send(slotBody(b, slot, { patient: { displayName: 'Guest Example' } }));
  if (res.status !== 201) throw new Error(`guest book ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as { data: { id: string }; guestAccess?: { claimCode: string } };
  return {
    id: body.data.id,
    claimCode: body.guestAccess?.claimCode ?? null,
    token: g.token,
    phone: g.phone,
  };
}

/** Verified phone change through the API (codes to the current and the new phone). */
export async function changePhone(h: Harness, s: LoggedIn, current: string, next: string) {
  await h.clearCooldowns();
  const req = await as(h, s).post('/me/phone/change-requests', { phone: next });
  if (req.status !== 202) throw new Error(`phone change ${req.status} ${JSON.stringify(req.body)}`);
  const ids = data<{ currentChallengeId: string; newChallengeId: string }>(req);
  return as(h, s).post('/me/phone/change-requests/verify', {
    phone: next,
    currentChallengeId: ids.currentChallengeId,
    currentCode: h.otp.lastCodeFor(current) ?? '',
    newChallengeId: ids.newChallengeId,
    newCode: h.otp.lastCodeFor(next) ?? '',
  });
}
