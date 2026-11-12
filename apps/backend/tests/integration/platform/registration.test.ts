import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { body } from '../support/fixtures.js';
import {
  adminSession,
  as,
  code,
  COMPLETE_REGISTRATION,
  createPlan,
  data,
  PDF,
  PNG,
  submitRegistration,
  userSession,
} from '../support/platform.js';

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => h.reset());

describe('clinic registration and approval', () => {
  it('draft → submit → review → needs information → resubmit → approve creates the operational clinic', async () => {
    const admin = await adminSession(h);
    const owner = await userSession(h);
    const planId = await createPlan(h, admin, { trialDays: 14 });

    const draft = await as(h, owner).post('/registrations', { clinicName: 'Draft Clinic' });
    expect(draft.status).toBe(201);
    const id = data<{ id: string; status: string }>(draft).id;
    expect(data<{ status: string }>(draft).status).toBe('DRAFT');

    expect(code(await as(h, owner).post(`/registrations/${id}/submit`))).toBe(
      'REGISTRATION_INCOMPLETE',
    );
    expect((await as(h, owner).patch(`/registrations/${id}`, COMPLETE_REGISTRATION)).status).toBe(
      200,
    );
    expect(
      (await as(h, owner).upload(`/registrations/${id}/documents`, 'BUSINESS_LICENSE')).status,
    ).toBe(201);
    expect(
      data<{ status: string }>(await as(h, owner).post(`/registrations/${id}/submit`)).status,
    ).toBe('PENDING_REVIEW');
    expect(
      code(await as(h, owner).patch(`/registrations/${id}`, { description: 'late edit' })),
    ).toBe('REGISTRATION_NOT_EDITABLE');

    expect(
      data<{ status: string }>(await as(h, admin).post(`/admin/registrations/${id}/start-review`))
        .status,
    ).toBe('UNDER_REVIEW');
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/registrations/${id}/request-information`, {
          reason: 'Please add the facility license',
        }),
      ).status,
    ).toBe('NEEDS_INFORMATION');
    expect(
      (await as(h, owner).upload(`/registrations/${id}/documents`, 'FACILITY_LICENSE')).status,
    ).toBe(201);
    expect(
      data<{ status: string }>(await as(h, owner).post(`/registrations/${id}/submit`)).status,
    ).toBe('PENDING_REVIEW');
    await as(h, admin).post(`/admin/registrations/${id}/start-review`);

    const approved = await as(h, admin).post(`/admin/registrations/${id}/approve`, {
      planId,
      billingCycle: 'MONTHLY',
      reason: 'All documents verified',
    });
    expect(approved.status).toBe(200);
    const { clinicId } = data<{ clinicId: string }>(approved);

    // Clinic, owner membership, main branch and trial subscription exist; owner can operate it.
    const profile = data<{
      clinic: { name: string; operationalStatus: string; approvedAt: string | null };
      operatingState: { subscriptionStatus: string };
    }>(await as(h, owner, { clinicId }).get('/clinic'));
    expect(profile.clinic).toMatchObject({
      name: 'Synthetic Health Clinic',
      operationalStatus: 'ACTIVE',
    });
    expect(profile.clinic.approvedAt).not.toBeNull();
    expect(profile.operatingState.subscriptionStatus).toBe('TRIAL');
    expect(data<unknown[]>(await as(h, owner, { clinicId }).get('/clinic/branches'))).toHaveLength(
      1,
    );
    const roles = data<{ clinics: { clinicId: string; roles: string[] }[] }>(
      await as(h, owner).get('/me/roles'),
    );
    expect(roles.clinics).toEqual([expect.objectContaining({ clinicId, roles: ['CLINIC_OWNER'] })]);

    // Complete review history with actors and reasons.
    const review = data<{
      history: {
        fromStatus: string | null;
        toStatus: string;
        actorUserId: string;
        reason: string | null;
      }[];
    }>(await as(h, admin).get(`/admin/registrations/${id}`));
    expect(review.history.map((x) => x.toStatus)).toEqual([
      'DRAFT',
      'PENDING_REVIEW',
      'UNDER_REVIEW',
      'NEEDS_INFORMATION',
      'PENDING_REVIEW',
      'UNDER_REVIEW',
      'APPROVED',
    ]);
    expect(review.history.at(-1)).toMatchObject({
      actorUserId: admin.userId,
      reason: 'All documents verified',
    });
    const audit = await h.db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE clinic_id = ? ORDER BY id`,
      [clinicId],
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['CLINIC_CREATED', 'MEMBERSHIP_CREATED', 'SUBSCRIPTION_CREATED']),
    );
    const events = await h.db.query<{ event_type: string }>(
      `SELECT event_type FROM domain_events WHERE clinic_id = ?`,
      [clinicId],
    );
    expect(events.map((e) => e.event_type)).toContain('clinic.approved');
  });

  it('rejects with a mandatory reason and keeps the request final', async () => {
    const admin = await adminSession(h);
    const owner = await userSession(h);
    const id = await submitRegistration(h, owner);
    await as(h, admin).post(`/admin/registrations/${id}/start-review`);
    expect((await as(h, admin).post(`/admin/registrations/${id}/reject`, {})).status).toBe(400);
    const rejected = await as(h, admin).post(`/admin/registrations/${id}/reject`, {
      reason: 'Business license invalid',
    });
    expect(
      data<{ status: string; decisionReason: string; decidedByUserId: string }>(rejected),
    ).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'Business license invalid',
      decidedByUserId: admin.userId,
    });
    expect(code(await as(h, admin).post(`/admin/registrations/${id}/start-review`))).toBe(
      'INVALID_TRANSITION',
    );
    expect(await h.db.query('SELECT id FROM clinics')).toHaveLength(0);
  });

  it('does not allow arbitrary transitions (no approval without review)', async () => {
    const admin = await adminSession(h);
    const planId = await createPlan(h, admin);
    const id = await submitRegistration(h, await userSession(h));
    expect(
      code(
        await as(h, admin).post(`/admin/registrations/${id}/approve`, {
          planId,
          billingCycle: 'MONTHLY',
        }),
      ),
    ).toBe('INVALID_TRANSITION');
  });

  it('a Super Admin cannot review or approve their own registration', async () => {
    const admin = await adminSession(h);
    const planId = await createPlan(h, admin);
    const id = await submitRegistration(h, admin);
    expect(code(await as(h, admin).post(`/admin/registrations/${id}/start-review`))).toBe(
      'SELF_APPROVAL_FORBIDDEN',
    );
    const other = await adminSession(h);
    await as(h, other).post(`/admin/registrations/${id}/start-review`);
    expect(
      code(
        await as(h, admin).post(`/admin/registrations/${id}/approve`, {
          planId,
          billingCycle: 'MONTHLY',
        }),
      ),
    ).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('a clinic owner (non-admin) cannot approve registrations at all', async () => {
    const owner = await userSession(h);
    const id = await submitRegistration(h, owner);
    expect((await as(h, owner).post(`/admin/registrations/${id}/start-review`)).status).toBe(403);
    expect((await as(h, owner).get('/admin/registrations')).status).toBe(403);
  });

  it('suspends and resumes a review; drafts are invisible to reviewers', async () => {
    const admin = await adminSession(h);
    const owner = await userSession(h);
    const draftId = data<{ id: string }>(
      await as(h, owner).post('/registrations', { clinicName: 'Secret Draft' }),
    ).id;
    expect((await as(h, admin).get(`/admin/registrations/${draftId}`)).status).toBe(404);
    const id = await submitRegistration(h, owner);
    const list = body<{ data: { id: string }[] }>(
      await as(h, admin).get('/admin/registrations?status=PENDING_REVIEW'),
    );
    expect(list.data.map((r) => r.id)).toEqual([id]);
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/registrations/${id}/suspend`, {
          reason: 'Suspected fraud',
        }),
      ).status,
    ).toBe('SUSPENDED');
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/registrations/${id}/resume`, { reason: 'Cleared' }),
      ).status,
    ).toBe('UNDER_REVIEW');
  });

  it('protects private documents: owner and reviewers only; manipulated ids are not found; reviewer access is audited', async () => {
    const admin = await adminSession(h);
    const owner = await userSession(h);
    const intruder = await userSession(h);
    const id = await submitRegistration(h, owner);
    const docs = data<{ documents: { id: string }[] }>(
      await as(h, owner).get(`/registrations/${id}`),
    ).documents;
    const docId = docs[0]!.id;

    const own = await as(h, owner).get(`/registrations/${id}/documents/${docId}/content`);
    expect(own.status).toBe(200);
    expect(own.headers['content-disposition']).toMatch(/^attachment/);
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(own.headers['cache-control']).toBe('no-store');

    expect(
      (await as(h, intruder).get(`/registrations/${id}/documents/${docId}/content`)).status,
    ).toBe(404);
    expect((await as(h, intruder).get(`/registrations/${id}`)).status).toBe(404);
    expect(
      (await as(h, intruder).get(`/admin/registrations/${id}/documents/${docId}/content`)).status,
    ).toBe(403);

    const otherReg = await submitRegistration(h, intruder);
    expect(
      (await as(h, owner).get(`/registrations/${otherReg}/documents/${docId}/content`)).status,
    ).toBe(404);
    expect(
      (await as(h, admin).get(`/admin/registrations/${otherReg}/documents/${docId}/content`))
        .status,
    ).toBe(404);

    expect(
      (await as(h, admin).get(`/admin/registrations/${id}/documents/${docId}/content`)).status,
    ).toBe(200);
    const audit = await h.db.query(
      `SELECT id FROM audit_events WHERE action = 'DOCUMENT_ACCESSED' AND actor_user_id = ?`,
      [admin.userId],
    );
    expect(audit).toHaveLength(1);
    expect(
      JSON.stringify(
        await as(h, owner)
          .get(`/registrations/${id}`)
          .then((r): unknown => r.body),
      ),
    ).not.toMatch(/storage_key|private\//);
  });

  it('rejects disguised or unsupported uploads', async () => {
    const owner = await userSession(h);
    const id = data<{ id: string }>(
      await as(h, owner).post('/registrations', { clinicName: 'Upload Clinic' }),
    ).id;
    expect(
      code(
        await as(h, owner).upload(
          `/registrations/${id}/documents`,
          'BUSINESS_LICENSE',
          PNG,
          'application/pdf',
        ),
      ),
    ).toBe('CONTENT_MISMATCH');
    expect(
      (
        await as(h, owner).upload(
          `/registrations/${id}/documents`,
          'BUSINESS_LICENSE',
          Buffer.from('<html>'),
          'text/html',
        )
      ).status,
    ).toBe(415);
    expect(
      (await as(h, owner).upload(`/registrations/${id}/documents`, 'PASSPORT', PDF)).status,
    ).toBe(400);
  });

  it('limits open requests per account', async () => {
    const owner = await userSession(h);
    for (let i = 0; i < 3; i++)
      expect(
        (await as(h, owner).post('/registrations', { clinicName: `Clinic ${i}` })).status,
      ).toBe(201);
    expect((await as(h, owner).post('/registrations', { clinicName: 'One too many' })).status).toBe(
      409,
    );
  });

  // Task 03.1 decision A (ADR-027): a SUSPENDED registration is a frozen review, nothing more.
  it('a suspended (frozen) review blocks applicant edits and every decision except resume/reject; no clinic exists', async () => {
    const admin = await adminSession(h);
    const owner = await userSession(h);
    const planId = await createPlan(h, admin);
    const id = await submitRegistration(h, owner);
    await as(h, admin).post(`/admin/registrations/${id}/start-review`);
    await as(h, admin).post(`/admin/registrations/${id}/suspend`, { reason: 'Suspected fraud' });

    expect(code(await as(h, owner).patch(`/registrations/${id}`, { description: 'x' }))).toBe(
      'REGISTRATION_NOT_EDITABLE',
    );
    expect(
      (await as(h, owner).upload(`/registrations/${id}/documents`, 'OTHER')).status,
    ).toBeGreaterThanOrEqual(400);
    expect(code(await as(h, owner).post(`/registrations/${id}/submit`))).toBe('INVALID_TRANSITION');
    expect(
      code(
        await as(h, admin).post(`/admin/registrations/${id}/approve`, {
          planId,
          billingCycle: 'MONTHLY',
        }),
      ),
    ).toBe('INVALID_TRANSITION');
    expect(
      code(
        await as(h, admin).post(`/admin/registrations/${id}/request-information`, {
          reason: 'Need more documents',
        }),
      ),
    ).toBe('INVALID_TRANSITION');
    expect(await h.db.query('SELECT id FROM clinics')).toEqual([]);
    expect((await as(h, owner).get(`/registrations/${id}`)).status).toBe(200);
    expect((await as(h, admin).get(`/admin/registrations/${id}`)).status).toBe(200);

    // Still an open request (counts toward the per-account limit) until it is rejected.
    expect(
      data<{ status: string }>(
        await as(h, admin).post(`/admin/registrations/${id}/reject`, { reason: 'Fraud confirmed' }),
      ).status,
    ).toBe('REJECTED');
    expect(await h.db.query('SELECT id FROM clinics')).toEqual([]);
  });

  // Task 03.1 decision B (ADR-028): approval is all-or-nothing and safe to retry.
  it('a failed approval leaves no partial clinic; a retry succeeds once; a second approval is rejected', async () => {
    const admin = await adminSession(h);
    const owner = await userSession(h);
    const planId = await createPlan(h, admin, { trialDays: 14 });
    const id = await submitRegistration(h, owner);
    await as(h, admin).post(`/admin/registrations/${id}/start-review`);
    const counts = async () => {
      const [row] = await h.db.query<Record<string, string>>(
        `SELECT (SELECT COUNT(*) FROM clinics) clinics, (SELECT COUNT(*) FROM clinic_branches) branches,
                (SELECT COUNT(*) FROM clinic_memberships) memberships,
                (SELECT COUNT(*) FROM clinic_subscriptions) subscriptions,
                (SELECT COUNT(*) FROM domain_events WHERE event_type = 'clinic.approved') events`,
      );
      return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
    };

    // The plan check runs after the clinic, branch and owner membership rows were inserted.
    const failed = await as(h, admin).post(`/admin/registrations/${id}/approve`, {
      planId: '999999999',
      billingCycle: 'MONTHLY',
    });
    expect(failed.status).toBe(400);
    expect(await counts()).toEqual({
      clinics: 0,
      branches: 0,
      memberships: 0,
      subscriptions: 0,
      events: 0,
    });
    expect(
      await h.db.query('SELECT status, clinic_id FROM clinic_registration_requests WHERE id = ?', [
        id,
      ]),
    ).toEqual([{ status: 'UNDER_REVIEW', clinic_id: null }]);

    const approved = await as(h, admin).post(`/admin/registrations/${id}/approve`, {
      planId,
      billingCycle: 'MONTHLY',
    });
    expect(approved.status).toBe(200);
    expect(await counts()).toEqual({
      clinics: 1,
      branches: 1,
      memberships: 1,
      subscriptions: 1,
      events: 1,
    });
    const [sub] = await h.db.query<{ status: string }>('SELECT status FROM clinic_subscriptions');
    expect(sub?.status).toBe('TRIAL');

    expect(
      code(
        await as(h, admin).post(`/admin/registrations/${id}/approve`, {
          planId,
          billingCycle: 'MONTHLY',
        }),
      ),
    ).toBe('INVALID_TRANSITION');
    expect((await counts()).clinics).toBe(1);
  });
});
