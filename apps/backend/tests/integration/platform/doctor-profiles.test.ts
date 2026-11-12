import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import type { LoggedIn } from '../support/fixtures.js';
import {
  addStaff,
  adminSession,
  as,
  code,
  data,
  onboardClinic,
  userSession,
} from '../support/platform.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let doctor: LoggedIn;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  await as(h, admin).put('/admin/specialties/cardiology', { name: 'Cardiology' });
  await as(h, admin).put('/admin/specialties/pediatrics', { name: 'Pediatrics' });
  doctor = await userSession(h);
});

const profileInput = {
  displayName: 'Dr. Synthetic Example',
  bio: 'Synthetic profile for tests',
  qualifications: [{ title: 'MD', institution: 'Test University', year: 2010 }],
  specialties: [{ code: 'cardiology', primary: true }],
  licenseNumber: 'LIC-0001',
  licenseAuthority: 'Test Medical Council',
  licenseCountry: 'US',
  licenseExpiresOn: '2030-12-31',
};

async function submitted(): Promise<string> {
  const created = await as(h, doctor).post('/me/doctor-profile', profileInput);
  expect(created.status).toBe(201);
  expect(
    (await as(h, doctor).upload('/me/doctor-profile/documents', 'MEDICAL_LICENSE')).status,
  ).toBe(201);
  expect(
    data<{ verificationStatus: string }>(
      await as(h, doctor).post('/me/doctor-profile/verification'),
    ).verificationStatus,
  ).toBe('PENDING_REVIEW');
  return data<{ id: string }>(created).id;
}

describe('doctor professional profiles', () => {
  it('creates a global profile with specialties and qualifications (one per account)', async () => {
    const res = await as(h, doctor).post('/me/doctor-profile', profileInput);
    expect(
      data<{
        verificationStatus: string;
        licenseExpiresOn: string;
        specialties: { code: string; primary: boolean }[];
      }>(res),
    ).toMatchObject({
      verificationStatus: 'UNVERIFIED',
      licenseExpiresOn: '2030-12-31',
      specialties: [{ code: 'cardiology', name: 'Cardiology', primary: true }],
    });
    expect((await as(h, doctor).post('/me/doctor-profile', profileInput)).status).toBe(409);
    expect(
      (await as(h, doctor).patch('/me/doctor-profile', { specialties: [{ code: 'unknown' }] }))
        .status,
    ).toBe(400);
    expect((await as(h, doctor).get('/specialties')).body).toMatchObject({
      data: [{ code: 'cardiology' }, { code: 'pediatrics' }],
    });
  });

  it('submission needs license data and a license document', async () => {
    await as(h, doctor).post('/me/doctor-profile', { displayName: 'Dr. Incomplete' });
    expect(code(await as(h, doctor).post('/me/doctor-profile/verification'))).toBe(
      'VERIFICATION_INCOMPLETE',
    );
  });

  it('Super Admin approves, suspends, reinstates and rejects with history; license data locks while verified', async () => {
    const id = await submitted();
    const decide = (decision: string) =>
      as(h, admin).post(`/admin/doctor-profiles/${id}/verification`, {
        decision,
        reason: 'Checked with the council',
      });
    expect(data<{ verificationStatus: string }>(await decide('APPROVE')).verificationStatus).toBe(
      'VERIFIED',
    );
    expect(
      code(await as(h, doctor).patch('/me/doctor-profile', { licenseNumber: 'LIC-9999' })),
    ).toBe('LICENSE_LOCKED');
    expect((await as(h, doctor).patch('/me/doctor-profile', { bio: 'Updated bio' })).status).toBe(
      200,
    );
    expect(data<{ verificationStatus: string }>(await decide('SUSPEND')).verificationStatus).toBe(
      'SUSPENDED',
    );
    expect(data<{ verificationStatus: string }>(await decide('REINSTATE')).verificationStatus).toBe(
      'VERIFIED',
    );
    expect(code(await decide('APPROVE'))).toBe('INVALID_TRANSITION');
    const review = data<{ history: { toStatus: string; actorUserId: string }[] }>(
      await as(h, admin).get(`/admin/doctor-profiles/${id}`),
    );
    expect(review.history.map((x) => x.toStatus)).toEqual([
      'PENDING_REVIEW',
      'VERIFIED',
      'SUSPENDED',
      'VERIFIED',
    ]);
  });

  it('rejection allows resubmission', async () => {
    const id = await submitted();
    await as(h, admin).post(`/admin/doctor-profiles/${id}/verification`, {
      decision: 'REJECT',
      reason: 'License number mismatch',
    });
    expect(
      (await as(h, doctor).patch('/me/doctor-profile', { licenseNumber: 'LIC-0002' })).status,
    ).toBe(200);
    expect(
      data<{ verificationStatus: string }>(
        await as(h, doctor).post('/me/doctor-profile/verification'),
      ).verificationStatus,
    ).toBe('PENDING_REVIEW');
  });

  it("clinic managers and owners cannot change a doctor's global status; doctors cannot verify themselves", async () => {
    const id = await submitted();
    const c = await onboardClinic(h, admin, { paid: true });
    const manager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER');
    for (const actor of [manager.session, c.owner, doctor]) {
      expect(
        (
          await as(h, actor, { clinicId: c.clinicId }).post(
            `/admin/doctor-profiles/${id}/verification`,
            { decision: 'APPROVE', reason: 'trust me' },
          )
        ).status,
      ).toBe(403);
    }
    const selfAdminDoctor = await adminSession(h);
    await as(h, selfAdminDoctor).post('/me/doctor-profile', profileInput);
    await as(h, selfAdminDoctor).upload('/me/doctor-profile/documents', 'MEDICAL_LICENSE');
    await as(h, selfAdminDoctor).post('/me/doctor-profile/verification');
    const ownId = data<{ profile: { id: string } }>(
      await as(h, selfAdminDoctor).get('/me/doctor-profile'),
    ).profile.id;
    expect(
      code(
        await as(h, selfAdminDoctor).post(`/admin/doctor-profiles/${ownId}/verification`, {
          decision: 'APPROVE',
          reason: 'self',
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('verification documents are private (owner + reviewers, audited)', async () => {
    const id = await submitted();
    const docId = data<{ documents: { id: string }[] }>(
      await as(h, doctor).get('/me/doctor-profile'),
    ).documents[0]!.id;
    const other = await userSession(h);
    await as(h, other).post('/me/doctor-profile', { displayName: 'Dr. Other' });
    expect((await as(h, other).get(`/me/doctor-profile/documents/${docId}/content`)).status).toBe(
      404,
    );
    expect((await as(h, doctor).get(`/me/doctor-profile/documents/${docId}/content`)).status).toBe(
      200,
    );
    expect(
      (await as(h, admin).get(`/admin/doctor-profiles/${id}/documents/${docId}/content`)).status,
    ).toBe(200);
    expect(
      await h.db.query(`SELECT id FROM audit_events WHERE action = 'DOCUMENT_ACCESSED'`),
    ).toHaveLength(1);
  });

  it('global verification grants no clinic membership or permissions', async () => {
    const id = await submitted();
    await as(h, admin).post(`/admin/doctor-profiles/${id}/verification`, {
      decision: 'APPROVE',
      reason: 'License verified',
    });
    const c = await onboardClinic(h, admin);
    expect(code(await as(h, doctor, { clinicId: c.clinicId }).get('/clinic'))).toBe(
      'CLINIC_ACCESS_DENIED',
    );
    expect(data<unknown[]>(await as(h, doctor).get('/me/memberships'))).toEqual([]);
  });
});
