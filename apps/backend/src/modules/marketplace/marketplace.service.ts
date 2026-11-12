import { z } from 'zod';
import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { AuthorizationService, Principal, TenantContext } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { Clinic, ClinicsRepository } from '../clinics/clinics.repository.js';
import type { DoctorProfileService } from '../doctor-profiles/doctor-profiles.service.js';
import { toPublicDoctor } from '../doctor-profiles/doctor-profiles.service.js';
import type { DomainEventOutbox } from '../platform/index.js';
import {
  permitsMarketplace,
  type ClinicSubscriptionState,
  type SubscriptionService,
} from '../subscriptions/index.js';

export const ELIGIBILITY_REASONS = [
  'REGISTRATION_NOT_APPROVED',
  'CLINIC_NOT_ACTIVE',
  'CLINIC_SUSPENDED',
  'SUBSCRIPTION_NOT_ELIGIBLE',
  'PLAN_EXCLUDES_MARKETPLACE',
  'VISIBILITY_DISABLED',
] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

export interface Eligibility {
  readonly eligible: boolean;
  /** Every unmet condition (empty when eligible). */
  readonly reasons: readonly EligibilityReason[];
}

/**
 * Marketplace eligibility (pure; unit-tested). ALL must hold: registration approved, clinic
 * ACTIVE, no open suspension, subscription in good standing, plan includes marketplace listing,
 * clinic enabled public visibility. Hiding never affects internal operations.
 */
export function evaluateMarketplaceEligibility(input: {
  clinic: Pick<Clinic, 'approvedAt' | 'operationalStatus' | 'publicVisibility'>;
  suspensionOpen: boolean;
  subscription: Pick<ClinicSubscriptionState, 'effective' | 'features'>;
}): Eligibility {
  const reasons: EligibilityReason[] = [];
  if (input.clinic.approvedAt === null) reasons.push('REGISTRATION_NOT_APPROVED');
  if (input.clinic.operationalStatus !== 'ACTIVE') reasons.push('CLINIC_NOT_ACTIVE');
  if (input.suspensionOpen) reasons.push('CLINIC_SUSPENDED');
  if (!input.subscription.effective.permitsNewOperations) reasons.push('SUBSCRIPTION_NOT_ELIGIBLE');
  else if (!permitsMarketplace(input.subscription.effective, input.subscription.features))
    reasons.push('PLAN_EXCLUDES_MARKETPLACE');
  if (!input.clinic.publicVisibility) reasons.push('VISIBILITY_DISABLED');
  return { eligible: reasons.length === 0, reasons };
}

export const visibilityPatchSchema = z
  .object({
    publicVisibility: z.boolean().optional(),
    doctorsPublicVisibility: z.boolean().optional(),
    servicesPublicVisibility: z.boolean().optional(),
  })
  .strict();

/** Public projections: explicit allow-lists. Legal identity, tax ids, owners, staff, contact data and statuses are never exposed. */
const publicClinic = (c: Clinic) => ({
  id: c.id,
  name: c.name,
  clinicType: c.clinicType,
  description: c.description,
  website: c.website,
  city: c.city,
  region: c.region,
  countryCode: c.countryCode,
});

export interface MarketplaceDeps {
  readonly db: Database;
  readonly clinics: ClinicsRepository;
  readonly subscriptions: SubscriptionService;
  readonly doctors: DoctorProfileService;
  readonly authz: AuthorizationService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
}

export class MarketplaceService {
  constructor(private readonly deps: MarketplaceDeps) {}

  /** Reusable eligibility query for one clinic. */
  async eligibility(
    executor: SqlExecutor,
    clinicId: string,
  ): Promise<Eligibility & { clinic: Clinic | undefined }> {
    const clinic = await this.deps.clinics.find(executor, clinicId);
    if (clinic === undefined)
      return { eligible: false, reasons: ['REGISTRATION_NOT_APPROVED'], clinic };
    const suspension = await this.deps.clinics.openSuspension(executor, clinicId);
    const subscription = await this.deps.subscriptions.stateFor(executor, clinicId);
    return {
      ...evaluateMarketplaceEligibility({
        clinic,
        suspensionOpen: suspension !== undefined,
        subscription,
      }),
      clinic,
    };
  }

  // ---------- clinic side ----------

  async settings(actor: Principal, tenant: TenantContext) {
    await this.deps.authz.assert(actor, 'clinic.marketplace.manage', { tenant });
    const { clinic, ...eligibility } = await this.eligibility(this.deps.db, tenant.clinicId);
    if (clinic === undefined) throw new NotFoundError('Clinic not found');
    return {
      publicVisibility: clinic.publicVisibility,
      doctorsPublicVisibility: clinic.doctorsPublicVisibility,
      servicesPublicVisibility: clinic.servicesPublicVisibility,
      eligibility,
    };
  }

  async updateSettings(
    actor: Principal,
    tenant: TenantContext,
    patch: z.infer<typeof visibilityPatchSchema>,
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'clinic.marketplace.manage', { tenant });
    await this.deps.db.transaction(async (tx) => {
      const before = await this.deps.clinics.find(tx, tenant.clinicId, true);
      if (before === undefined) throw new NotFoundError('Clinic not found');
      const columns: Record<string, number> = {};
      if (patch.publicVisibility !== undefined)
        columns.public_visibility = patch.publicVisibility ? 1 : 0;
      if (patch.doctorsPublicVisibility !== undefined)
        columns.doctors_public_visibility = patch.doctorsPublicVisibility ? 1 : 0;
      if (patch.servicesPublicVisibility !== undefined)
        columns.services_public_visibility = patch.servicesPublicVisibility ? 1 : 0;
      await this.deps.clinics.update(tx, tenant.clinicId, columns);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MARKETPLACE_VISIBILITY_CHANGED,
          actorUserId: actor.userId,
          targetType: 'CLINIC',
          targetId: tenant.clinicId,
          clinicId: tenant.clinicId,
          metadata: {
            before: {
              publicVisibility: before.publicVisibility,
              doctorsPublicVisibility: before.doctorsPublicVisibility,
              servicesPublicVisibility: before.servicesPublicVisibility,
            },
            after: patch,
          },
        },
        meta,
      );
      await this.deps.outbox.record(tx, {
        type: 'marketplace.visibility_changed',
        aggregateType: 'clinic',
        aggregateId: tenant.clinicId,
        clinicId: tenant.clinicId,
        payload: patch,
      });
    });
    return this.settings(actor, tenant);
  }

  // ---------- public (no authentication) ----------

  /**
   * Eligible clinics, newest first. SQL prefilters the static conditions; subscription standing
   * (time-dependent) is evaluated in code with the same rules, so a page may hold fewer than
   * `limit` items while nextCursor is still set.
   */
  async listPublicClinics(page: { limit: number; cursor?: string | undefined }) {
    const rows = await this.deps.db.query<{ id: string }>(
      `SELECT c.id FROM clinics c
        WHERE c.approved_at IS NOT NULL AND c.operational_status = 'ACTIVE' AND c.public_visibility = 1
          AND NOT EXISTS (SELECT 1 FROM clinic_suspensions s WHERE s.clinic_id = c.id AND s.ended_at IS NULL)
          AND (? IS NULL OR c.id < ?)
        ORDER BY c.id DESC LIMIT ?`,
      [page.cursor ?? null, page.cursor ?? null, page.limit + 1],
    );
    const data = [];
    for (const { id } of rows.slice(0, page.limit)) {
      const result = await this.eligibility(this.deps.db, id);
      if (result.eligible && result.clinic !== undefined) data.push(publicClinic(result.clinic));
    }
    const last = rows.slice(0, page.limit).at(-1);
    return {
      data,
      page: {
        limit: page.limit,
        nextCursor: rows.length > page.limit && last !== undefined ? last.id : null,
      },
    };
  }

  async publicClinic(clinicId: string) {
    const result = await this.eligibility(this.deps.db, clinicId);
    if (!result.eligible || result.clinic === undefined)
      throw new NotFoundError('Clinic not found');
    const clinic = result.clinic;
    const branches = await this.deps.db.query<{
      id: string;
      name: string;
      address_line1: string | null;
      city: string | null;
      region: string | null;
      country_code: string | null;
      latitude: string | null;
      longitude: string | null;
      time_zone: string;
    }>(
      `SELECT id, name, address_line1, city, region, country_code, latitude, longitude, time_zone FROM clinic_branches WHERE clinic_id = ? AND status = 'ACTIVE' ORDER BY name`,
      [clinicId],
    );
    return {
      ...publicClinic(clinic),
      branches: branches.map((b) => ({
        id: b.id,
        name: b.name,
        addressLine1: b.address_line1,
        city: b.city,
        region: b.region,
        countryCode: b.country_code,
        latitude: b.latitude === null ? null : Number(b.latitude),
        longitude: b.longitude === null ? null : Number(b.longitude),
        timeZone: b.time_zone,
      })),
      doctors: clinic.doctorsPublicVisibility ? await this.listedDoctors(clinicId) : [],
    };
  }

  /** A doctor is public only if verified, active, opted in, and listed by at least one eligible clinic. */
  async publicDoctor(profileId: string) {
    const profile = await this.deps.doctors.findById(this.deps.db, profileId);
    if (
      profile?.verificationStatus !== 'VERIFIED' ||
      profile.profileStatus !== 'ACTIVE' ||
      !profile.publicVisibility
    )
      throw new NotFoundError('Doctor not found');
    const clinicIds = await this.deps.db.query<{ clinic_id: string }>(
      `SELECT DISTINCT m.clinic_id FROM clinic_memberships m JOIN clinics c ON c.id = m.clinic_id
        WHERE m.user_id = ? AND m.role_code = 'DOCTOR' AND m.status = 'ACTIVE' AND m.public_listing = 1 AND c.doctors_public_visibility = 1`,
      [profile.userId],
    );
    const clinics = [];
    for (const { clinic_id } of clinicIds) {
      const result = await this.eligibility(this.deps.db, clinic_id);
      if (result.eligible && result.clinic !== undefined)
        clinics.push({ id: result.clinic.id, name: result.clinic.name });
    }
    if (clinics.length === 0) throw new NotFoundError('Doctor not found');
    return { ...toPublicDoctor(profile), clinics };
  }

  private async listedDoctors(clinicId: string) {
    const rows = await this.deps.db.query<{ id: string }>(
      `SELECT dp.id FROM clinic_memberships m JOIN doctor_profiles dp ON dp.user_id = m.user_id
        WHERE m.clinic_id = ? AND m.role_code = 'DOCTOR' AND m.status = 'ACTIVE' AND m.public_listing = 1
          AND dp.verification_status = 'VERIFIED' AND dp.profile_status = 'ACTIVE' AND dp.public_visibility = 1
        ORDER BY dp.display_name`,
      [clinicId],
    );
    const doctors = [];
    for (const { id } of rows) {
      const profile = await this.deps.doctors.findById(this.deps.db, id);
      if (profile !== undefined) doctors.push(toPublicDoctor(profile));
    }
    return doctors;
  }
}
