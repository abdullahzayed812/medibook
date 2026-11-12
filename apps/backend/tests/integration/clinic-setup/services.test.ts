import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import {
  addStaff,
  adminSession,
  code,
  data,
  onboardClinic,
  type OnboardedClinic,
} from '../support/platform.js';
import { addBranch, api, assign, verifiedDoctor } from '../support/setup.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let c: OnboardedClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  c = await onboardClinic(h, admin, { paid: true });
  await h.db.execute(`INSERT INTO specialties (code, name) VALUES ('cardiology', 'Cardiology')`);
});

interface Offering {
  id: string;
  status: string;
  available: boolean;
  price: { amountMinor: number; currency: string };
  durationMinutes: number;
}
interface DoctorService {
  assignmentId: string;
  available: boolean;
  durationMinutes: number;
  price: { amountMinor: number };
}
const owner = () => api(h, c.owner, c);
const createService = async (body: object) => {
  const res = await owner().post('/clinic/services', body);
  expect(res.status).toBe(201);
  return data<{ id: string }>(res).id;
};
const offer = (branchId: string, serviceId: string, body: object) =>
  owner().put(`/clinic/branches/${branchId}/services/${serviceId}`, body);

describe('clinic service catalog', () => {
  it('creates bilingual and custom services with optional specialty; validates names, codes and specialties', async () => {
    const consult = await owner().post('/clinic/services', {
      code: 'cardio_consult',
      nameEn: 'Cardiology consultation',
      nameAr: 'كشف قلب',
      descriptionEn: 'First visit',
      preparationEn: 'Bring previous ECGs',
      specialtyCode: 'cardiology',
    });
    expect(consult.status).toBe(201);
    expect(data(consult)).toMatchObject({
      code: 'cardio_consult',
      name: { en: 'Cardiology consultation', ar: 'كشف قلب' },
      specialtyCode: 'cardiology',
      status: 'ACTIVE',
    });
    // Custom service, Arabic name only, no catalog/specialty link.
    expect((await owner().post('/clinic/services', { nameAr: 'جلسة علاج طبيعي' })).status).toBe(
      201,
    );
    expect(code(await owner().post('/clinic/services', { descriptionEn: 'nameless' }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      code(await owner().post('/clinic/services', { nameEn: 'X', specialtyCode: 'astrology' })),
    ).toBe('UNKNOWN_SPECIALTY');
    expect(
      code(await owner().post('/clinic/services', { nameEn: 'Dup', code: 'cardio_consult' })),
    ).toBe('CONFLICT');
    const list = data<{ id: string }[]>(await owner().get('/clinic/services?specialty=cardiology'));
    expect(list).toHaveLength(1);
  });

  it('offers a service at several branches with different prices and durations; PUT is idempotent; default currency EGP', async () => {
    const second = await addBranch(h, c, 'Second');
    const service = await createService({ nameEn: 'Consultation' });
    const a = await offer(c.branchId, service, { priceMinor: 30000, durationMinutes: 20 });
    expect(a.status).toBe(201);
    expect(data<Offering>(a)).toMatchObject({
      price: { amountMinor: 30000, currency: 'EGP' },
      durationMinutes: 20,
      available: true,
    });
    const b = await offer(second, service, {
      priceMinor: 45000,
      currency: 'USD',
      durationMinutes: 30,
      bufferMinutes: 10,
    });
    expect(data<Offering>(b)).toMatchObject({
      price: { amountMinor: 45000, currency: 'USD' },
      durationMinutes: 30,
    });
    const again = await offer(c.branchId, service, { priceMinor: 35000, durationMinutes: 25 });
    expect(again.status).toBe(200);
    expect(data<Offering>(again).id).toBe(data<Offering>(a).id);
    expect(
      await h.db.query('SELECT id FROM branch_service_offerings WHERE service_id = ?', [service]),
    ).toHaveLength(2);
    // Range validation
    expect(code(await offer(c.branchId, service, { priceMinor: -1, durationMinutes: 20 }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(code(await offer(c.branchId, service, { priceMinor: 100, durationMinutes: 2 }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      code(
        await offer(c.branchId, service, { priceMinor: 100, durationMinutes: 20, currency: 'egp' }),
      ),
    ).toBe('VALIDATION_ERROR');
    const audits = await h.db.query<{
      metadata: { before: unknown; after: { priceMinor: number } };
    }>(`SELECT metadata FROM audit_events WHERE action = 'SERVICE_OFFERING_CHANGED' ORDER BY id`);
    expect(audits[2]?.metadata).toMatchObject({
      before: { priceMinor: 30000 },
      after: { priceMinor: 35000 },
    });
  });

  it('assigns several doctors to a service at a branch, with optional per-doctor overrides', async () => {
    const service = await createService({ nameEn: 'Echo' });
    await offer(c.branchId, service, { priceMinor: 80000, durationMinutes: 30 });
    const d1 = await assign(h, c, c.branchId, (await verifiedDoctor(h, c)).membershipId);
    const d2 = await assign(h, c, c.branchId, (await verifiedDoctor(h, c)).membershipId);
    const put = (a: string, body: object = {}) =>
      owner().put(`/clinic/doctor-assignments/${a}/services/${service}`, body);
    expect((await put(d1)).status).toBe(201);
    const senior = await put(d2, { priceMinor: 120000, durationMinutes: 45 });
    expect(senior.status).toBe(201);
    expect(data<DoctorService>(senior)).toMatchObject({
      durationMinutes: 45,
      price: { amountMinor: 120000 },
    });
    expect((await put(d1)).status).toBe(200); // idempotent
    const doctors = data<DoctorService[]>(
      await owner().get(`/clinic/branches/${c.branchId}/services/${service}/doctors`),
    );
    expect(doctors.map((d) => d.assignmentId).sort()).toEqual([d1, d2].sort());
    // Not inferred: a third doctor at the branch is not eligible until assigned.
    const d3 = await assign(h, c, c.branchId, (await verifiedDoctor(h, c)).membershipId);
    expect(
      data<DoctorService[]>(await owner().get(`/clinic/doctor-assignments/${d3}/services`)),
    ).toEqual([]);
    // Remove (ends, keeps history).
    expect(
      (await owner().delete(`/clinic/doctor-assignments/${d1}/services/${service}`)).status,
    ).toBe(204);
    expect(
      data<{ status: string }[]>(
        await owner().get(`/clinic/doctor-assignments/${d1}/services`),
      ).map((x) => x.status),
    ).toEqual(['ENDED']);
  });

  it('rejects doctor/service/branch combinations across branches and clinics', async () => {
    const second = await addBranch(h, c, 'Second');
    const service = await createService({ nameEn: 'X-ray' });
    await offer(second, service, { priceMinor: 1000, durationMinutes: 10 });
    const atMain = await assign(h, c, c.branchId, (await verifiedDoctor(h, c)).membershipId);
    // Service offered only at the second branch: not assignable to a main-branch doctor.
    expect(
      (await owner().put(`/clinic/doctor-assignments/${atMain}/services/${service}`, {})).status,
    ).toBe(404);

    const c2 = await onboardClinic(h, admin, { paid: true });
    const foreignService = data<{ id: string }>(
      await api(h, c2.owner, c2).post('/clinic/services', { nameEn: 'Foreign' }),
    ).id;
    expect((await owner().get(`/clinic/services/${foreignService}`)).status).toBe(404);
    expect(
      (await offer(c.branchId, foreignService, { priceMinor: 1, durationMinutes: 10 })).status,
    ).toBe(404);
    expect(
      (
        await api(h, c2.owner, c2).put(
          `/clinic/doctor-assignments/${atMain}/services/${foreignService}`,
          {},
        )
      ).status,
    ).toBe(404);
    expect((await api(h, c2.owner, c2).get(`/clinic/branches/${c.branchId}/services`)).status).toBe(
      404,
    );
  });

  it('deactivating a service keeps offerings and doctor assignments as history but makes them unavailable', async () => {
    const service = await createService({ nameEn: 'Dental cleaning' });
    await offer(c.branchId, service, { priceMinor: 50000, durationMinutes: 40 });
    const d = await assign(h, c, c.branchId, (await verifiedDoctor(h, c)).membershipId);
    await owner().put(`/clinic/doctor-assignments/${d}/services/${service}`, {});
    expect(
      (await owner().patch(`/clinic/services/${service}`, { status: 'INACTIVE' })).status,
    ).toBe(200);
    const offering = data<Offering>(
      await owner().get(`/clinic/branches/${c.branchId}/services/${service}`),
    );
    expect(offering).toMatchObject({ status: 'ACTIVE', available: false });
    expect(
      data<DoctorService[]>(await owner().get(`/clinic/doctor-assignments/${d}/services`))[0],
    ).toMatchObject({
      available: false,
    });
    expect(code(await offer(c.branchId, service, { priceMinor: 1, durationMinutes: 10 }))).toBe(
      'SERVICE_INACTIVE',
    );
    const d2 = await assign(h, c, c.branchId, (await verifiedDoctor(h, c)).membershipId);
    expect(
      code(await owner().put(`/clinic/doctor-assignments/${d2}/services/${service}`, {})),
    ).toBe('OFFERING_NOT_AVAILABLE');
    expect(await h.db.query('SELECT id FROM clinic_services WHERE id = ?', [service])).toHaveLength(
      1,
    );
  });

  it('staff may view the catalog; only managers change it; branch-assigned staff see only their branches', async () => {
    const service = await createService({ nameEn: 'Consultation' });
    const other = await addBranch(h, c, 'Other');
    await offer(c.branchId, service, { priceMinor: 100, durationMinutes: 10 });
    await offer(other, service, { priceMinor: 200, durationMinutes: 10 });
    const receptionist = await addStaff(h, c.owner, c.clinicId, 'RECEPTIONIST', {
      branchScope: 'ASSIGNED',
      branchIds: [c.branchId],
    });
    const r = api(h, receptionist.session, c);
    expect((await r.get('/clinic/services')).status).toBe(200);
    expect((await r.get(`/clinic/branches/${c.branchId}/services`)).status).toBe(200);
    expect((await r.get(`/clinic/branches/${other}/services`)).status).toBe(404);
    expect(code(await r.post('/clinic/services', { nameEn: 'Nope' }))).toBe('FORBIDDEN');
    expect(
      code(
        await r.put(`/clinic/branches/${c.branchId}/services/${service}`, {
          priceMinor: 1,
          durationMinutes: 10,
        }),
      ),
    ).toBe('FORBIDDEN');
  });
});
