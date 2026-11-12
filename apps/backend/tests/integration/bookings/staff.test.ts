import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import { addStaff, adminSession, as, code, data } from '../support/platform.js';
import { addBranch, assign, doctorSchedule, every, verifiedDoctor } from '../support/setup.js';
import {
  book,
  bookableClinic,
  bookSlot,
  key,
  patient,
  slotBody,
  slots,
  statusOf,
  type BookableClinic,
  type Slot,
} from '../support/bookings.js';

/** Task 05.1: clinic staff create bookings through the SAME engine (pending, never pre-confirmed). */
const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let b: BookableClinic;
let receptionist: LoggedIn;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  b = await bookableClinic(h, admin);
  receptionist = (await addStaff(h, b.c.owner, b.c.clinicId, 'RECEPTIONIST')).session;
});

const slotAt = async (start: string): Promise<Slot> => {
  const s = (await slots(h, b)).slots.find((x) => x.local.start === start);
  if (s === undefined) throw new Error(`no slot ${start}`);
  return s;
};
const staffBody = (slot: Slot, patientRef: object) => ({
  branchId: b.c.branchId,
  serviceId: b.serviceId,
  assignmentId: slot.assignmentId,
  startsAt: slot.startsAt,
  patient: patientRef,
});
const staffBook = (s: LoggedIn, body: object, idem = key(), clinicId = b.c.clinicId) =>
  as(h, s, { clinicId }).post('/clinic/bookings', body).set('Idempotency-Key', idem);
const newPatient = { new: { displayName: 'Walk-in Example', contactPhone: '+12025550177' } };

interface ClinicView {
  id: string;
  status: string;
  bookedBy: { kind: string };
  patient: { patientProfileId: string; displayName: string; contactPhone: string | null };
}

describe('staff-created bookings', () => {
  it('an authorized receptionist books a new walk-in patient: pending request, staff actor, separate beneficiary', async () => {
    const res = await staffBook(receptionist, staffBody(await slotAt('09:00'), newPatient));
    expect(res.status).toBe(201);
    const v = data<ClinicView>(res);
    expect(v).toMatchObject({
      status: 'PENDING_CONFIRMATION',
      bookedBy: { kind: 'STAFF' },
      patient: { displayName: 'Walk-in Example', contactPhone: '+12025550177' },
    });
    const [row] = await h.db.query<{
      actor_user_id: string;
      person_id: string;
      actor_kind: string;
      delegation_id: string | null;
    }>('SELECT actor_user_id, person_id, actor_kind, delegation_id FROM bookings WHERE id = ?', [
      v.id,
    ]);
    expect(row).toMatchObject({
      actor_user_id: receptionist.userId,
      actor_kind: 'STAFF',
      delegation_id: null,
    });
    expect(
      await h.db.query('SELECT kind, user_id, phone_hash FROM booking_persons WHERE id = ?', [
        row?.person_id ?? '',
      ]),
    ).toEqual([{ kind: 'CLINIC', user_id: null, phone_hash: null }]); // never matched to anyone by phone
    expect(await h.db.query('SELECT id FROM booking_delegations')).toEqual([]); // no delegation, no record access
    expect(
      await h.db.query(
        'SELECT to_status, actor_kind FROM booking_status_history WHERE booking_id = ?',
        [v.id],
      ),
    ).toEqual([{ to_status: 'PENDING_CONFIRMATION', actor_kind: 'STAFF' }]);
    // Same clinic patient again, by profile: still the same person.
    const again = await staffBook(
      receptionist,
      staffBody(await slotAt('11:00'), { patientProfileId: v.patient.patientProfileId }),
    );
    const [row2] = await h.db.query<{ person_id: string }>(
      'SELECT person_id FROM bookings WHERE id = ?',
      [data<ClinicView>(again).id],
    );
    expect(row2?.person_id).toBe(row?.person_id);
  });

  it('books an existing patient of the clinic by profile; profiles of another clinic are 404', async () => {
    const p = await patient(h);
    const own = await bookSlot(h, b, p, '09:00');
    const [{ patient_profile_id: profile } = { patient_profile_id: '' }] = await h.db.query<{
      patient_profile_id: string;
    }>('SELECT patient_profile_id FROM bookings WHERE id = ?', [own]);
    const res = await staffBook(
      receptionist,
      staffBody(await slotAt('10:00'), { patientProfileId: profile }),
    );
    expect(res.status).toBe(201);
    expect(data<{ id: string }[]>(await as(h, p).get('/me/bookings')).map((x) => x.id)).toContain(
      data<ClinicView>(res).id,
    ); // the patient sees it
    const other = await bookableClinic(h, admin);
    const foreign = await bookSlot(h, other, await patient(h), '09:00');
    const [{ patient_profile_id: foreignProfile } = { patient_profile_id: '' }] = await h.db.query<{
      patient_profile_id: string;
    }>('SELECT patient_profile_id FROM bookings WHERE id = ?', [foreign]);
    expect(
      (
        await staffBook(
          receptionist,
          staffBody(await slotAt('11:00'), { patientProfileId: foreignProfile }),
        )
      ).status,
    ).toBe(404);
  });

  it('unauthorized staff and out-of-scope branches are rejected', async () => {
    const doctorApi = b.doctor.session;
    expect(code(await staffBook(doctorApi, staffBody(await slotAt('09:00'), newPatient)))).toBe(
      'FORBIDDEN',
    ); // doctors may not book
    const second = await addBranch(h, b.c, 'Second', 'Africa/Cairo');
    const scoped = (
      await addStaff(h, b.c.owner, b.c.clinicId, 'RECEPTIONIST', {
        branchScope: 'ASSIGNED',
        branchIds: [second],
      })
    ).session;
    expect((await staffBook(scoped, staffBody(await slotAt('09:00'), newPatient))).status).toBe(
      404,
    ); // main branch not covered
    const outsider = (
      await addStaff(
        h,
        (await bookableClinic(h, admin)).c.owner,
        (await h.db.query<{ id: string }>('SELECT id FROM clinics ORDER BY id DESC LIMIT 1'))[0]
          ?.id ?? '',
        'RECEPTIONIST',
      )
    ).session;
    expect(code(await staffBook(outsider, staffBody(await slotAt('09:00'), newPatient)))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect(await h.db.query('SELECT id FROM bookings')).toEqual([]);
  });

  it('doctor, patient and gate rules still apply; staff cannot skip confirmation', async () => {
    const p = await patient(h);
    const taken = await bookSlot(h, b, p, '09:00');
    const s9 = await h.db.query<{ starts_at: Date; patient_profile_id: string }>(
      'SELECT starts_at, patient_profile_id FROM bookings WHERE id = ?',
      [taken],
    );
    const at9 = s9[0]?.starts_at.toISOString() ?? '';
    const profile = s9[0]?.patient_profile_id ?? '';
    // Doctor conflict: the doctor is taken at 09:00.
    expect(
      code(
        await staffBook(
          receptionist,
          staffBody({ assignmentId: b.assignmentId, startsAt: at9 } as Slot, newPatient),
        ),
      ),
    ).toBe('SLOT_UNAVAILABLE');
    // Patient conflict: same patient, same time, with a SECOND doctor who is free.
    const d2 = await verifiedDoctor(h, b.c);
    const a2 = await assign(h, b.c, b.c.branchId, d2.membershipId);
    await doctorSchedule(h, b.c, a2, { effectiveFrom: b.t0, periods: every('09:00', '13:00') });
    await as(h, b.c.owner, { clinicId: b.c.clinicId }).put(
      `/clinic/doctor-assignments/${a2}/services/${b.serviceId}`,
      {},
    );
    expect(
      code(
        await staffBook(
          receptionist,
          staffBody({ assignmentId: a2, startsAt: at9 } as Slot, { patientProfileId: profile }),
        ),
      ),
    ).toBe('PATIENT_CONFLICT');
    // A free time for that patient works, and stays a pending request.
    const ok = await staffBook(
      receptionist,
      staffBody(await slotAt('11:00'), { patientProfileId: profile }),
    );
    expect(data<ClinicView>(ok).status).toBe('PENDING_CONFIRMATION');
    // Gate: a NEW_OPERATIONS suspension blocks staff bookings too.
    const s12 = await slotAt('12:00');
    await as(h, admin).post(`/admin/clinics/${b.c.clinicId}/suspend`, {
      scope: 'NEW_OPERATIONS',
      reason: 'Fines',
    });
    expect(code(await staffBook(receptionist, staffBody(s12, newPatient)))).toBe(
      'CLINIC_SUSPENDED',
    );
  });

  it('concurrent staff and patient requests for one slot: exactly one wins', async () => {
    const p = await patient(h);
    const first = await bookSlot(h, b, p, '09:00');
    const s10 = await slotAt('10:00');
    const competitors = await Promise.all([
      staffBook(receptionist, staffBody(s10, newPatient)),
      staffBook(
        (await addStaff(h, b.c.owner, b.c.clinicId, 'RECEPTIONIST')).session,
        staffBody(s10, { new: { displayName: 'Caller Two' } }),
      ),
      book(h, await patient(h), slotBody(b, s10)),
      book(h, await patient(h), slotBody(b, s10)),
    ]);
    expect(competitors.filter((r) => r.status === 201)).toHaveLength(1);
    expect(competitors.filter((r) => code(r) === 'SLOT_UNAVAILABLE')).toHaveLength(3);
    expect(await statusOf(h, first)).toBe('PENDING_CONFIRMATION');
  });

  it('idempotency: replay returns the same booking; another payload with the key conflicts; failures leave no person', async () => {
    const k = key();
    const body = staffBody(await slotAt('09:00'), newPatient);
    const a = await staffBook(receptionist, body, k);
    const r = await staffBook(receptionist, body, k);
    expect(data<ClinicView>(r).id).toBe(data<ClinicView>(a).id);
    expect(
      code(await staffBook(receptionist, staffBody(await slotAt('10:00'), newPatient), k)),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const persons = await h.db.query('SELECT id FROM booking_persons WHERE kind = ?', ['CLINIC']);
    expect(persons).toHaveLength(1); // the replay created no second person
    // A failed staff booking (slot taken) rolls back its new clinic person too.
    expect(code(await staffBook(receptionist, body))).toBe('SLOT_UNAVAILABLE');
    expect(
      await h.db.query('SELECT id FROM booking_persons WHERE kind = ?', ['CLINIC']),
    ).toHaveLength(1);
  });

  it('booking-for-others rules: staff cannot book for persons outside the clinic, nor use patient delegations', async () => {
    const parent = await patient(h);
    const child = data<{ personId: string }>(
      await as(h, parent).post('/me/dependents', {
        displayName: 'Child',
        birthDate: '2019-01-01',
        relationship: 'GUARDIAN',
      }),
    );
    const res = await staffBook(receptionist, {
      ...staffBody(await slotAt('09:00'), { patientProfileId: '999999' }),
    });
    expect(res.status).toBe(404);
    expect(
      (
        await staffBook(receptionist, {
          ...staffBody(await slotAt('09:00'), newPatient),
          personId: child.personId,
        })
      ).status,
    ).toBe(400); // no personId field
  });
});
