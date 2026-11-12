import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import {
  addMembership,
  body,
  createBranch,
  createClinic,
  createUser,
  grantGlobalRole,
  login,
  testPhone,
} from '../support/fixtures.js';

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => h.reset());

describe('API v1 contract', () => {
  it('keeps Task 01 endpoints working alongside /api/v1', async () => {
    expect((await h.http().get('/health')).status).toBe(200);
    expect((await h.http().get('/health/ready')).status).toBe(200);
    const missing = await h.http().get('/api/v1/does-not-exist');
    expect(missing.status).toBe(404);
    expect(body<{ error: { code: string; requestId: string } }>(missing).error).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('uses the uniform error envelope with a correlation id for auth failures', async () => {
    const res = await h.http().get('/api/v1/me').set('X-Request-Id', 'api-test-1');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required', requestId: 'api-test-1' },
    });
  });

  it('OTP request → 202 with { data: { challengeId, expiresAt, resendAvailableAt } }', async () => {
    const res = await h.http().post('/api/v1/auth/otp/request').send({ phone: testPhone() });
    expect(res.status).toBe(202);
    expect(Object.keys(body<{ data: object }>(res).data).sort()).toEqual([
      'challengeId',
      'expiresAt',
      'resendAvailableAt',
    ]);
  });

  it('GET /me returns the account, profile and MFA status without secrets', async () => {
    const s = await login(h, testPhone());
    const res = await h.http().get('/api/v1/me').set('Authorization', s.bearer);
    expect(res.status).toBe(200);
    expect(body<{ data: object }>(res).data).toMatchObject({
      id: s.userId,
      status: 'ACTIVE',
      profile: { displayName: null, preferredLocale: null },
      doctorProfile: null,
      mfa: { enrolled: false, pendingEnrollment: false, verifiedForSession: false },
    });
  });

  it('GET /me/roles separates global roles from clinic roles', async () => {
    const user = await createUser(h.db);
    await grantGlobalRole(h.db, user.id, 'PATIENT');
    const clinicA = await createClinic(h.db, 'Alpha');
    const clinicB = await createClinic(h.db, 'Beta');
    await addMembership(h.db, { clinicId: clinicA, userId: user.id, role: 'CLINIC_OWNER' });
    await addMembership(h.db, { clinicId: clinicA, userId: user.id, role: 'DOCTOR' });
    await addMembership(h.db, { clinicId: clinicB, userId: user.id, role: 'DOCTOR' });
    await addMembership(h.db, {
      clinicId: await createClinic(h.db, 'Gone'),
      userId: user.id,
      role: 'RECEPTIONIST',
      status: 'TERMINATED',
    });
    const s = await login(h, user.phone);
    const data = body<{
      data: { global: string[]; clinics: { clinicName: string; roles: string[] }[] };
    }>(await h.http().get('/api/v1/me/roles').set('Authorization', s.bearer)).data;
    expect(data.global).toEqual(['PATIENT']);
    expect(data.clinics).toEqual([
      { clinicId: clinicA, clinicName: 'Alpha', roles: ['CLINIC_OWNER', 'DOCTOR'] },
      { clinicId: clinicB, clinicName: 'Beta', roles: ['DOCTOR'] },
    ]);
  });

  it('GET /me/memberships includes status, branch scope and branches', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    const branch = await createBranch(h.db, clinic);
    await addMembership(h.db, {
      clinicId: clinic,
      userId: user.id,
      role: 'DOCTOR',
      branchScope: 'ASSIGNED',
      branchIds: [branch],
    });
    const s = await login(h, user.phone);
    const data = body<{ data: object[] }>(
      await h.http().get('/api/v1/me/memberships').set('Authorization', s.bearer),
    ).data;
    expect(data).toEqual([
      expect.objectContaining({
        clinicId: clinic,
        role: 'DOCTOR',
        status: 'ACTIVE',
        branchScope: 'ASSIGNED',
        branchIds: [branch],
      }),
    ]);
  });

  it('GET /me/permissions reports clinic permissions only for a validated context', async () => {
    const user = await createUser(h.db);
    const clinic = await createClinic(h.db);
    await addMembership(h.db, { clinicId: clinic, userId: user.id, role: 'RECEPTIONIST' });
    const s = await login(h, user.phone);
    const without = body<{
      data: { clinic: unknown; platform: { permissions: string[]; mfaSatisfied: boolean } };
    }>(await h.http().get('/api/v1/me/permissions').set('Authorization', s.bearer)).data;
    expect(without.clinic).toBeNull();
    expect(without.platform).toEqual({ permissions: [], mfaSatisfied: true });
    const withCtx = body<{ data: { clinic: { roles: string[]; permissions: string[] } } }>(
      await h
        .http()
        .get('/api/v1/me/permissions')
        .set('Authorization', s.bearer)
        .set('X-Clinic-Id', clinic),
    ).data;
    expect(withCtx.clinic.roles).toEqual(['RECEPTIONIST']);
    expect(withCtx.clinic.permissions).toEqual([
      // Task 05: reject/cancel bookings (CONTINUITY_OF_CARE)
      'clinic.bookings.cancel',
      'clinic.bookings.manage',
      'clinic.bookings.view',
      'clinic.branches.view',
      'clinic.patients.manage',
      'clinic.patients.view',
      'clinic.payments.manage',
      'clinic.profile.view',
      'clinic.queue.manage',
      // Task 04: read access to services and schedules (configuration, not patient data)
      'clinic.schedules.view',
      'clinic.services.view',
    ]);
  });

  it('clinic context: list clinics, switch (persisted on the session), list branches', async () => {
    const user = await createUser(h.db);
    const clinicA = await createClinic(h.db, 'Alpha');
    const clinicB = await createClinic(h.db, 'Beta');
    const a1 = await createBranch(h.db, clinicA, 'A-North');
    await createBranch(h.db, clinicA, 'A-South');
    const b1 = await createBranch(h.db, clinicB, 'B-Main');
    await addMembership(h.db, { clinicId: clinicA, userId: user.id, role: 'CLINIC_MANAGER' });
    await addMembership(h.db, {
      clinicId: clinicB,
      userId: user.id,
      role: 'DOCTOR',
      branchScope: 'ASSIGNED',
      branchIds: [b1],
    });
    const s = await login(h, user.phone);
    const auth = { Authorization: s.bearer };

    const clinics = body<{ data: { id: string; current: boolean }[] }>(
      await h.http().get('/api/v1/context/clinics').set(auth),
    ).data;
    expect(clinics.map((c) => c.id)).toEqual([clinicA, clinicB]);
    expect(clinics.every((c) => !c.current)).toBe(true);

    expect((await h.http().get('/api/v1/context/branches').set(auth)).status).toBe(400);
    expect(
      (await h.http().post('/api/v1/context/clinic').set(auth).send({ clinicId: clinicA })).status,
    ).toBe(200);
    const branchesA = body<{ data: { id: string; name: string }[] }>(
      await h.http().get('/api/v1/context/branches').set(auth),
    ).data;
    expect(branchesA.map((b) => b.name)).toEqual(['A-North', 'A-South']);
    expect(branchesA[0]?.id).toBe(a1);

    // Header overrides the remembered context for a single request.
    const branchesB = body<{ data: { id: string }[] }>(
      await h.http().get('/api/v1/context/branches').set(auth).set('X-Clinic-Id', clinicB),
    ).data;
    expect(branchesB.map((b) => b.id)).toEqual([b1]);

    const after = body<{ data: { id: string; current: boolean }[] }>(
      await h.http().get('/api/v1/context/clinics').set(auth),
    ).data;
    expect(after.find((c) => c.current)?.id).toBe(clinicA);
    expect(
      (await h.http().post('/api/v1/context/clinic').set(auth).send({ clinicId: null })).status,
    ).toBe(200);
    expect(
      (await h.http().post('/api/v1/context/clinic').set(auth).send({ clinicId: 'abc' })).status,
    ).toBe(400);
  });

  it('paginates security events with an opaque cursor', async () => {
    const s = await login(h, testPhone());
    await h.http().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
    const first = body<{
      data: { id: string; type: string }[];
      page: { limit: number; nextCursor: string | null };
    }>(await h.http().get('/api/v1/me/security-events?limit=2').set('Authorization', s.bearer));
    expect(first.data).toHaveLength(2);
    expect(first.page.nextCursor).not.toBeNull();
    const second = body<{ data: { id: string }[] }>(
      await h
        .http()
        .get(`/api/v1/me/security-events?limit=2&cursor=${first.page.nextCursor}`)
        .set('Authorization', s.bearer),
    );
    expect(second.data.length).toBeGreaterThan(0);
    expect(Number(second.data[0]!.id)).toBeLessThan(Number(first.data[1]!.id));
    expect(
      (await h.http().get('/api/v1/me/security-events?limit=1000').set('Authorization', s.bearer))
        .status,
    ).toBe(400);
  });

  it('only shows a user their own security events', async () => {
    const a = await login(h, testPhone());
    const b = await login(h, testPhone());
    const events = body<{ data: { sessionId: string | null }[] }>(
      await h.http().get('/api/v1/me/security-events').set('Authorization', a.bearer),
    ).data;
    expect(events.some((e) => e.sessionId === b.sessionId)).toBe(false);
  });

  it('validates path parameters', async () => {
    const s = await login(h, testPhone());
    expect(
      (await h.http().delete('/api/v1/sessions/abc').set('Authorization', s.bearer)).status,
    ).toBe(400);
    expect(
      (
        await h
          .http()
          .post('/api/v1/admin/users/abc/suspend')
          .set('Authorization', s.bearer)
          .send({ reason: 'xxx' })
      ).status,
    ).toBe(403);
  });
});
