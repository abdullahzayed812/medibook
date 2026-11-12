import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { body, type LoggedIn } from '../support/fixtures.js';
import {
  addStaff,
  adminSession,
  as,
  createPlan,
  data,
  onboardClinic,
  type OnboardedClinic,
} from '../support/platform.js';

const h = createHarness();
afterAll(() => h.close());

let admin: LoggedIn;
let c: OnboardedClinic;
beforeEach(async () => {
  await h.reset();
  admin = await adminSession(h);
  c = await onboardClinic(h, admin, { paid: true });
});

const owner = () => as(h, c.owner, { clinicId: c.clinicId });
const eligibility = async () =>
  data<{ eligibility: { eligible: boolean; reasons: string[] } }>(
    await owner().get('/clinic/marketplace'),
  ).eligibility;
const pub = (path: string) => h.http().get(`/api/v1/public${path}`);

describe('marketplace eligibility and public visibility', () => {
  it('is hidden by default and becomes public only when all conditions hold', async () => {
    expect(await eligibility()).toEqual({ eligible: false, reasons: ['VISIBILITY_DISABLED'] });
    expect((await pub(`/clinics/${c.clinicId}`)).status).toBe(404);
    expect((await owner().patch('/clinic/marketplace', { publicVisibility: true })).status).toBe(
      200,
    );
    expect((await eligibility()).eligible).toBe(true);
    const listed = body<{ data: { id: string }[] }>(await pub('/clinics'));
    expect(listed.data.map((x) => x.id)).toEqual([c.clinicId]);
  });

  it('public responses expose no private clinic information', async () => {
    await owner().patch('/clinic/marketplace', { publicVisibility: true });
    const text = JSON.stringify((await pub(`/clinics/${c.clinicId}`)).body);
    for (const secret of [
      'legalName',
      'businessRegistrationNo',
      'taxId',
      'TEST-123',
      'Synthetic Health LLC',
      'contactPhone',
      'contactEmail',
      'operationalStatus',
      'approvedAt',
      'owner',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('suspension, closure or a non-eligible subscription/plan remove the clinic without affecting operations', async () => {
    await owner().patch('/clinic/marketplace', { publicVisibility: true });
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/suspend`, {
      scope: 'NEW_OPERATIONS',
      reason: 'Investigation',
    });
    expect((await eligibility()).reasons).toEqual(
      expect.arrayContaining(['CLINIC_SUSPENDED', 'CLINIC_NOT_ACTIVE']),
    );
    expect((await pub(`/clinics/${c.clinicId}`)).status).toBe(404);
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/reinstate`, { reason: 'Cleared' });
    const noMarket = await createPlan(h, admin, { marketplace: false });
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/change-plan`, {
      planId: noMarket,
      reason: 'Basic plan',
    });
    expect((await eligibility()).reasons).toEqual(['PLAN_EXCLUDES_MARKETPLACE']);
    await as(h, admin).post(`/admin/clinics/${c.clinicId}/subscription/expire`, {
      reason: 'Ended',
    });
    expect((await eligibility()).reasons).toEqual(['SUBSCRIPTION_NOT_ELIGIBLE']);
    // Hiding never disables internal operations.
    await owner().patch('/clinic/marketplace', { publicVisibility: false });
    expect((await owner().get('/clinic/branches')).status).toBe(200);
  });

  it('doctors are public only if verified, opted in, listed by the clinic and the clinic shows doctors', async () => {
    await owner().patch('/clinic/marketplace', { publicVisibility: true });
    const doc = await addStaff(h, c.owner, c.clinicId, 'DOCTOR');
    await as(h, doc.session).post('/me/doctor-profile', {
      displayName: 'Dr. Public Test',
      licenseNumber: 'L-1',
      licenseAuthority: 'Council',
      publicVisibility: true,
    });
    await as(h, doc.session).upload('/me/doctor-profile/documents', 'MEDICAL_LICENSE');
    await as(h, doc.session).post('/me/doctor-profile/verification');
    const profileId = data<{ profile: { id: string } }>(
      await as(h, doc.session).get('/me/doctor-profile'),
    ).profile.id;
    const doctors = async () =>
      data<{ doctors: { id: string }[] }>(await pub(`/clinics/${c.clinicId}`)).doctors.map(
        (d) => d.id,
      );

    expect(await doctors()).toEqual([]);
    await owner().patch(`/clinic/members/${doc.membershipId}/public-listing`, {
      publicListing: true,
    });
    expect(await doctors()).toEqual([]); // not verified yet
    await as(h, admin).post(`/admin/doctor-profiles/${profileId}/verification`, {
      decision: 'APPROVE',
      reason: 'License verified',
    });
    expect(await doctors()).toEqual([profileId]);
    const publicDoctor: unknown = (await pub(`/doctors/${profileId}`)).body;
    expect(JSON.stringify(publicDoctor)).not.toMatch(/L-1|licenseNumber|userId|Council/);
    await owner().patch('/clinic/marketplace', { doctorsPublicVisibility: false });
    expect(await doctors()).toEqual([]);
    expect((await pub(`/doctors/${profileId}`)).status).toBe(404);
  });

  it('visibility changes are audited and require clinic.marketplace.manage', async () => {
    const manager = await addStaff(h, c.owner, c.clinicId, 'CLINIC_MANAGER');
    expect(
      (
        await as(h, manager.session, { clinicId: c.clinicId }).patch('/clinic/marketplace', {
          publicVisibility: true,
        })
      ).status,
    ).toBe(403);
    await owner().patch('/clinic/marketplace', { publicVisibility: true });
    expect(
      await h.db.query(
        `SELECT id FROM audit_events WHERE action = 'MARKETPLACE_VISIBILITY_CHANGED'`,
      ),
    ).toHaveLength(1);
  });
});
