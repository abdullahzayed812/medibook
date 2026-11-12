import { Router } from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Container } from '../../../src/container.js';
import {
  clinicContext,
  requirePermission,
  requireTenant,
} from '../../../src/modules/access/index.js';
import { createVerifiedClinicScope } from '../../../src/modules/access/tenancy/clinic-scope-factory.js';
import { NotFoundError } from '../../../src/shared/errors/app-error.js';
import { validate } from '../../../src/shared/http/middleware/validate.js';
import { createHarness } from '../support/harness.js';
import {
  addMembership,
  body,
  createBranch,
  createClinic,
  createUser,
  login,
  type LoggedIn,
} from '../support/fixtures.js';

/**
 * Probe routes built exactly like future clinic-scoped endpoints: authenticate → clinicContext →
 * requirePermission → handler using a tenant-scoped repository with req.tenant.scope.
 */
function probeRoutes(c: Container): Router {
  const router = Router();
  const ctx = clinicContext(c.services.resolver);
  const repo = c.repositories.patientProfiles;
  const idParams = validate({ params: z.object({ id: z.string().regex(/^[1-9]\d*$/) }) });
  router.get(
    '/patients',
    c.authenticate,
    ctx,
    requirePermission(c.services.authz, 'clinic.patients.view'),
    async (req, res) => {
      const tenant = requireTenant(req);
      res.json({
        clinicId: tenant.clinicId,
        ...(await repo.list(c.db, tenant.scope, { limit: 100 })),
      });
    },
  );
  router.get(
    '/patients/:id',
    c.authenticate,
    ctx,
    requirePermission(c.services.authz, 'clinic.patients.view'),
    idParams,
    async (req, res) => {
      const profile = await repo.findById(
        c.db,
        requireTenant(req).scope,
        (req.params as { id: string }).id,
      );
      if (profile === undefined) throw new NotFoundError('Patient not found');
      res.json({ data: profile });
    },
  );
  router.patch(
    '/patients/:id',
    c.authenticate,
    ctx,
    requirePermission(c.services.authz, 'clinic.patients.manage'),
    idParams,
    validate({ body: z.object({ displayName: z.string().min(1) }) }),
    async (req, res) => {
      const ok = await repo.updateDisplayName(
        c.db,
        requireTenant(req).scope,
        (req.params as { id: string }).id,
        (req.body as { displayName: string }).displayName,
      );
      if (!ok) throw new NotFoundError('Patient not found');
      res.status(204).end();
    },
  );
  router.delete(
    '/patients/:id',
    c.authenticate,
    ctx,
    requirePermission(c.services.authz, 'clinic.patients.manage'),
    idParams,
    async (req, res) => {
      const ok = await repo.delete(
        c.db,
        requireTenant(req).scope,
        (req.params as { id: string }).id,
      );
      if (!ok) throw new NotFoundError('Patient not found');
      res.status(204).end();
    },
  );
  return router;
}

const h = createHarness({ extraRoutes: probeRoutes });
afterAll(() => h.close());

interface World {
  clinicA: string;
  clinicB: string;
  userA: LoggedIn;
  patientA: string;
  patientB: string;
}

let world: World;

beforeEach(async () => {
  await h.reset();
  const clinicA = await createClinic(h.db, 'Clinic A');
  const clinicB = await createClinic(h.db, 'Clinic B');
  const a = await createUser(h.db);
  const b = await createUser(h.db);
  await addMembership(h.db, { clinicId: clinicA, userId: a.id, role: 'RECEPTIONIST' });
  await addMembership(h.db, { clinicId: clinicB, userId: b.id, role: 'RECEPTIONIST' });
  const repo = h.container.repositories.patientProfiles;
  const patientA = await repo.create(h.db, createVerifiedClinicScope(clinicA, null), {
    displayName: 'Synthetic Patient A',
  });
  const patientB = await repo.create(h.db, createVerifiedClinicScope(clinicB, null), {
    displayName: 'Synthetic Patient B',
  });
  world = { clinicA, clinicB, userA: await login(h, a.phone), patientA, patientB };
});

const as = (s: LoggedIn, clinicId?: string) => {
  const withHeaders = <T extends { set: (k: string, v: string) => T }>(r: T) => {
    const authed = r.set('Authorization', s.bearer);
    return clinicId === undefined ? authed : authed.set('X-Clinic-Id', clinicId);
  };
  return {
    get: (path: string) => withHeaders(h.http().get(`/api/v1/test${path}`)),
    patch: (path: string, payload: object) =>
      withHeaders(h.http().patch(`/api/v1/test${path}`)).send(payload),
    delete: (path: string) => withHeaders(h.http().delete(`/api/v1/test${path}`)),
  };
};
const code = (res: { body: unknown }) => body<{ error?: { code: string } }>(res).error?.code;

describe('tenant isolation', () => {
  it('baseline: a user can read, update and delete records of their own clinic', async () => {
    const { userA, clinicA, patientA } = world;
    expect((await as(userA, clinicA).get(`/patients/${patientA}`)).status).toBe(200);
    expect(
      (await as(userA, clinicA).patch(`/patients/${patientA}`, { displayName: 'Renamed' })).status,
    ).toBe(204);
    expect((await as(userA, clinicA).delete(`/patients/${patientA}`)).status).toBe(204);
  });

  it('a user from Clinic A cannot READ Clinic B records', async () => {
    const { userA, clinicA, patientB } = world;
    const res = await as(userA, clinicA).get(`/patients/${patientB}`);
    expect(res.status).toBe(404);
    const list = body<{ data: { id: string; clinicId: string }[] }>(
      await as(userA, clinicA).get('/patients'),
    ).data;
    expect(list.map((p) => p.id)).not.toContain(patientB);
    expect(list.every((p) => p.clinicId === clinicA)).toBe(true);
  });

  it('a user from Clinic A cannot UPDATE Clinic B records', async () => {
    const { userA, clinicA, patientB } = world;
    expect(
      (await as(userA, clinicA).patch(`/patients/${patientB}`, { displayName: 'Hijacked' })).status,
    ).toBe(404);
    const [row] = await h.db.query<{ display_name: string }>(
      'SELECT display_name FROM patient_profiles WHERE id = ?',
      [patientB],
    );
    expect(row?.display_name).toBe('Synthetic Patient B');
  });

  it('a user from Clinic A cannot DELETE Clinic B records', async () => {
    const { userA, clinicA, patientB } = world;
    expect((await as(userA, clinicA).delete(`/patients/${patientB}`)).status).toBe(404);
    expect(
      await h.db.query('SELECT id FROM patient_profiles WHERE id = ?', [patientB]),
    ).toHaveLength(1);
  });

  it('rejects manipulated clinic ids (another clinic, nonexistent, malformed)', async () => {
    const { userA, clinicB, patientB } = world;
    const other = await as(userA, clinicB).get(`/patients/${patientB}`);
    expect(other.status).toBe(403);
    expect(code(other)).toBe('CLINIC_ACCESS_DENIED');
    const missing = await as(userA, '999999999').get('/patients');
    expect(code(missing)).toBe('CLINIC_ACCESS_DENIED'); // same answer: existence is not revealed
    for (const bad of ['1 OR 1=1', '-1', '0', 'abc', '1,2']) {
      expect(code(await as(userA, bad).get('/patients'))).toBe('INVALID_CLINIC_CONTEXT');
    }
  });

  it('ignores clinic ids supplied in the query or body', async () => {
    const { userA, clinicA, clinicB } = world;
    const res = await as(userA, clinicA).get(`/patients?clinicId=${clinicB}&clinic_id=${clinicB}`);
    expect(body<{ clinicId: string }>(res).clinicId).toBe(clinicA);
  });

  it('rejects manipulated resource ids belonging to another clinic as not found (no existence leak)', async () => {
    const { userA, clinicA, patientB } = world;
    const foreign = await as(userA, clinicA).get(`/patients/${patientB}`);
    const nonexistent = await as(userA, clinicA).get('/patients/987654321');
    expect(foreign.status).toBe(nonexistent.status);
    expect(code(foreign)).toBe(code(nonexistent));
  });

  it('rejects missing clinic context for clinic-scoped operations', async () => {
    const res = await as(world.userA).get('/patients');
    expect(res.status).toBe(400);
    expect(code(res)).toBe('CLINIC_CONTEXT_REQUIRED');
  });

  it('re-validates a remembered clinic context on every request', async () => {
    const { userA, clinicA } = world;
    await h
      .http()
      .post('/api/v1/context/clinic')
      .set('Authorization', userA.bearer)
      .send({ clinicId: clinicA });
    expect((await as(userA).get('/patients')).status).toBe(200);
    await h.db.execute(`UPDATE clinic_memberships SET status = 'SUSPENDED' WHERE user_id = ?`, [
      userA.userId,
    ]);
    expect(code(await as(userA).get('/patients'))).toBe('CLINIC_ACCESS_DENIED');
  });

  it('refuses to remember a clinic the user is not a member of', async () => {
    const res = await h
      .http()
      .post('/api/v1/context/clinic')
      .set('Authorization', world.userA.bearer)
      .send({ clinicId: world.clinicB });
    expect(code(res)).toBe('CLINIC_ACCESS_DENIED');
    const [session] = await h.db.query<{ active_clinic_id: string | null }>(
      'SELECT active_clinic_id FROM sessions WHERE id = ?',
      [world.userA.sessionId],
    );
    expect(session?.active_clinic_id).toBeNull();
  });

  it('does not leak context between concurrent requests using different clinics', async () => {
    const { clinicA, clinicB } = world;
    const both = await createUser(h.db);
    await addMembership(h.db, { clinicId: clinicA, userId: both.id, role: 'RECEPTIONIST' });
    await addMembership(h.db, { clinicId: clinicB, userId: both.id, role: 'RECEPTIONIST' });
    const s = await login(h, both.phone);
    const clinics = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? clinicA : clinicB));
    const responses = await Promise.all(
      clinics.map((clinicId) => as(s, clinicId).get('/patients')),
    );
    responses.forEach((res, i) => {
      const payload = body<{ clinicId: string; data: { clinicId: string }[] }>(res);
      expect(res.status).toBe(200);
      expect(payload.clinicId).toBe(clinics[i]);
      expect(payload.data.every((p) => p.clinicId === clinics[i])).toBe(true);
    });
  });

  it('restricts branch-assigned members to their branches', async () => {
    const { clinicA } = world;
    const north = await createBranch(h.db, clinicA, 'North');
    const south = await createBranch(h.db, clinicA, 'South');
    const user = await createUser(h.db);
    await addMembership(h.db, {
      clinicId: clinicA,
      userId: user.id,
      role: 'RECEPTIONIST',
      branchScope: 'ASSIGNED',
      branchIds: [north],
    });
    const s = await login(h, user.phone);
    expect(code(await as(s, clinicA).get('/patients'))).toBe('BRANCH_CONTEXT_REQUIRED');
    expect((await as(s, clinicA).get('/patients').set('X-Branch-Id', north)).status).toBe(200);
    expect(code(await as(s, clinicA).get('/patients').set('X-Branch-Id', south))).toBe(
      'BRANCH_ACCESS_DENIED',
    );
  });

  it('repository guard rejects an unscoped statement before it reaches MySQL', async () => {
    const { tenantExecutor } = await import('../../../src/modules/access/index.js');
    const scoped = tenantExecutor(h.db, createVerifiedClinicScope(world.clinicA, null));
    await expect(
      Promise.resolve().then(() => scoped.query('SELECT id FROM patient_profiles')),
    ).rejects.toThrow(/clinic_id/);
    await expect(
      Promise.resolve().then(() =>
        scoped.execute('DELETE FROM patient_profiles WHERE clinic_id = ?', [world.clinicB]),
      ),
    ).rejects.toThrow(/does not bind/);
    expect(await h.db.query('SELECT id FROM patient_profiles')).toHaveLength(2);
  });
});
