import type { SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import { tenantExecutor, type Principal, type TenantContext } from '../access/index.js';
import { AUDIT_ACTION } from '../audit/index.js';
import {
  assertConfigurable,
  authorizeBranch,
  iso,
  loadAssignment,
  loadBranch,
  recordChange,
  type SetupDeps,
} from './context.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

export interface ServiceInput {
  readonly code?: string | null | undefined;
  readonly nameEn?: string | null | undefined;
  readonly nameAr?: string | null | undefined;
  readonly descriptionEn?: string | null | undefined;
  readonly descriptionAr?: string | null | undefined;
  readonly preparationEn?: string | null | undefined;
  readonly preparationAr?: string | null | undefined;
  readonly specialtyCode?: string | null | undefined;
  readonly status?: 'ACTIVE' | 'INACTIVE' | undefined;
}

const SERVICE_COLUMNS: Record<keyof ServiceInput, string> = {
  code: 'code',
  nameEn: 'name_en',
  nameAr: 'name_ar',
  descriptionEn: 'description_en',
  descriptionAr: 'description_ar',
  preparationEn: 'preparation_en',
  preparationAr: 'preparation_ar',
  specialtyCode: 'specialty_code',
  status: 'status',
};

const toService = (r: Row) => ({
  id: String(r.id),
  code: str(r.code),
  name: { en: str(r.name_en), ar: str(r.name_ar) },
  description: { en: str(r.description_en), ar: str(r.description_ar) },
  preparation: { en: str(r.preparation_en), ar: str(r.preparation_ar) },
  specialtyCode: str(r.specialty_code),
  status: r.status as 'ACTIVE' | 'INACTIVE',
  createdAt: iso(r.created_at as Date),
  updatedAt: iso(r.updated_at as Date),
});

export interface OfferingInput {
  readonly priceMinor: number;
  readonly currency?: string | undefined;
  readonly durationMinutes: number;
  readonly bufferMinutes?: number | undefined;
  readonly instructionsEn?: string | null | undefined;
  readonly instructionsAr?: string | null | undefined;
  readonly status?: 'ACTIVE' | 'INACTIVE' | undefined;
}

const OFFERING_SELECT = `
  SELECT o.*, s.name_en, s.name_ar, s.status AS service_status, s.specialty_code
    FROM branch_service_offerings o
    JOIN clinic_services s ON s.id = o.service_id AND s.clinic_id = o.clinic_id`;

const toOffering = (r: Row) => ({
  id: String(r.id),
  branchId: String(r.branch_id),
  service: {
    id: String(r.service_id),
    name: { en: str(r.name_en), ar: str(r.name_ar) },
    status: r.service_status as 'ACTIVE' | 'INACTIVE',
    specialtyCode: str(r.specialty_code),
  },
  status: r.status as 'ACTIVE' | 'INACTIVE',
  /** Offered now: offering and service both active. */
  available: r.status === 'ACTIVE' && r.service_status === 'ACTIVE',
  price: { amountMinor: Number(r.price_minor), currency: r.currency as string },
  durationMinutes: Number(r.duration_minutes),
  bufferMinutes: Number(r.buffer_minutes),
  instructions: { en: str(r.instructions_en), ar: str(r.instructions_ar) },
  updatedAt: iso(r.updated_at as Date),
});

const DOCTOR_SERVICE_SELECT = `
  SELECT d.*, o.service_id, o.price_minor AS offering_price, o.currency, o.duration_minutes AS offering_duration,
         o.status AS offering_status, s.name_en, s.name_ar, s.status AS service_status,
         a.status AS assignment_status, dp.display_name
    FROM doctor_service_assignments d
    JOIN branch_service_offerings o ON o.id = d.offering_id AND o.clinic_id = d.clinic_id
    JOIN clinic_services s ON s.id = o.service_id AND s.clinic_id = o.clinic_id
    JOIN doctor_branch_assignments a ON a.id = d.assignment_id AND a.clinic_id = d.clinic_id
    JOIN doctor_profiles dp ON dp.id = a.doctor_profile_id`;

const toDoctorService = (r: Row) => ({
  id: String(r.id),
  assignmentId: String(r.assignment_id),
  doctorDisplayName: r.display_name as string,
  branchId: String(r.branch_id),
  offeringId: String(r.offering_id),
  service: {
    id: String(r.service_id),
    name: { en: str(r.name_en), ar: str(r.name_ar) },
    status: r.service_status as string,
  },
  status: r.status as 'ACTIVE' | 'ENDED',
  available:
    r.status === 'ACTIVE' &&
    r.offering_status === 'ACTIVE' &&
    r.service_status === 'ACTIVE' &&
    r.assignment_status === 'ACTIVE',
  /** Doctor-specific override, else the branch offering value. */
  durationMinutes: Number(r.duration_minutes ?? r.offering_duration),
  price: { amountMinor: Number(r.price_minor ?? r.offering_price), currency: r.currency as string },
  overrides: {
    durationMinutes: r.duration_minutes === null ? null : Number(r.duration_minutes),
    priceMinor: r.price_minor === null ? null : Number(r.price_minor),
  },
  createdAt: iso(r.created_at as Date),
  endedAt: iso(r.ended_at as Date | null),
});

/**
 * Clinic service catalog, branch offerings and explicit doctor-service eligibility. Writes need
 * `clinic.services.manage` (catalog, offerings) or `clinic.doctors.manage` (doctor services);
 * reads need `clinic.services.view`, and branch-level reads additionally require coverage of
 * the branch. Nothing is deleted; deactivation keeps every reference.
 */
export class ServiceCatalogService {
  constructor(private readonly deps: SetupDeps) {}

  // ---------- clinic services ----------

  async list(
    actor: Principal,
    tenant: TenantContext,
    filter: {
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
      specialty?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    await this.deps.authz.assert(actor, 'clinic.services.view', { tenant });
    const rows = await tenantExecutor(this.deps.db, tenant.scope).query<Row>(
      `SELECT * FROM clinic_services WHERE clinic_id = ? AND (? IS NULL OR status = ?)
          AND (? IS NULL OR specialty_code = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      [
        tenant.clinicId,
        filter.status ?? null,
        filter.status ?? null,
        filter.specialty ?? null,
        filter.specialty ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return toPage(rows.map(toService), filter.limit);
  }

  async get(actor: Principal, tenant: TenantContext, serviceId: string) {
    await this.deps.authz.assert(actor, 'clinic.services.view', { tenant });
    return toService(await this.loadService(this.deps.db, tenant, serviceId));
  }

  async create(actor: Principal, tenant: TenantContext, input: ServiceInput, meta: RequestMeta) {
    await this.deps.authz.assert(actor, 'clinic.services.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      await this.assertSpecialty(tx, input.specialtyCode);
      await this.assertCodeFree(tx, tenant, input.code, null);
      const entries = Object.entries(input).filter(([, v]) => v !== undefined);
      const id = String(
        (
          await tenantExecutor(tx, tenant.scope).execute(
            `INSERT INTO clinic_services (clinic_id, created_by_user_id, ${entries.map(([k]) => SERVICE_COLUMNS[k as keyof ServiceInput]).join(', ')})
             VALUES (?, ?, ${entries.map(() => '?').join(', ')})`,
            [tenant.clinicId, actor.userId, ...entries.map(([, v]) => v as string | null)],
          )
        ).insertId,
      );
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.SERVICE_CREATED,
          actor,
          tenant,
          targetType: 'SERVICE',
          targetId: id,
          metadata: { serviceId: id, after: input },
          event: 'service.created',
        },
        meta,
      );
      return toService(await this.loadService(tx, tenant, id));
    });
  }

  async update(
    actor: Principal,
    tenant: TenantContext,
    serviceId: string,
    patch: ServiceInput,
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'clinic.services.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      const before = await this.loadService(tx, tenant, serviceId, true);
      await this.assertSpecialty(tx, patch.specialtyCode);
      await this.assertCodeFree(tx, tenant, patch.code, serviceId);
      const nameEn = patch.nameEn === undefined ? before.name_en : patch.nameEn;
      const nameAr = patch.nameAr === undefined ? before.name_ar : patch.nameAr;
      if (nameEn === null && nameAr === null)
        throw new AppError(400, 'VALIDATION_ERROR', 'A name in English or Arabic is required', {
          details: [{ location: 'body', path: 'nameEn', message: 'nameEn or nameAr is required' }],
        });
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (entries.length > 0)
        await tenantExecutor(tx, tenant.scope).execute(
          `UPDATE clinic_services SET ${entries.map(([k]) => `${SERVICE_COLUMNS[k as keyof ServiceInput]} = ?`).join(', ')}
            WHERE id = ? AND clinic_id = ?`,
          [...entries.map(([, v]) => v as string | null), serviceId, tenant.clinicId],
        );
      const after = await this.loadService(tx, tenant, serviceId);
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.SERVICE_CHANGED,
          actor,
          tenant,
          targetType: 'SERVICE',
          targetId: serviceId,
          metadata: {
            serviceId,
            changed: entries.map(([k]) => k),
            before: pick(
              toService(before),
              entries.map(([k]) => k),
            ),
            after: pick(
              toService(after),
              entries.map(([k]) => k),
            ),
            status: after.status,
          },
          event: 'service.changed',
        },
        meta,
      );
      return toService(after);
    });
  }

  // ---------- branch offerings ----------

  async listOfferings(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    filter: {
      status?: 'ACTIVE' | 'INACTIVE' | undefined;
      serviceId?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.services.view');
    const rows = await tenantExecutor(this.deps.db, bt.scope).query<Row>(
      `${OFFERING_SELECT} WHERE o.clinic_id = ? AND o.branch_id = ? AND (? IS NULL OR o.status = ?)
          AND (? IS NULL OR o.service_id = ?) AND (? IS NULL OR o.id < ?) ORDER BY o.id DESC LIMIT ?`,
      [
        bt.clinicId,
        branchId,
        filter.status ?? null,
        filter.status ?? null,
        filter.serviceId ?? null,
        filter.serviceId ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return toPage(rows.map(toOffering), filter.limit);
  }

  async getOffering(actor: Principal, tenant: TenantContext, branchId: string, serviceId: string) {
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.services.view');
    const row = await this.findOffering(this.deps.db, bt, branchId, serviceId);
    if (row === undefined) throw new NotFoundError('Service offering not found');
    return toOffering(row);
  }

  /**
   * Idempotent upsert of the (branch, service) offering. Returns `created` so the route can
   * answer 201 or 200. A new or re-activated offering needs an ACTIVE service.
   */
  async upsertOffering(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    serviceId: string,
    input: OfferingInput,
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'clinic.services.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      await loadBranch(tx, tenant, branchId);
      const service = await this.loadService(tx, tenant, serviceId);
      const status = input.status ?? 'ACTIVE';
      if (status === 'ACTIVE' && service.status !== 'ACTIVE')
        throw new AppError(409, 'SERVICE_INACTIVE', 'The service is inactive');
      const before = await this.findOffering(tx, tenant, branchId, serviceId, true);
      const currency =
        input.currency ?? (await this.deps.settings.get('clinic.default_currency', tx));
      const values = [
        status,
        input.priceMinor,
        currency,
        input.durationMinutes,
        input.bufferMinutes ?? 0,
        input.instructionsEn ?? null,
        input.instructionsAr ?? null,
        actor.userId,
      ];
      const t = tenantExecutor(tx, tenant.scope);
      if (before === undefined)
        await t.execute(
          `INSERT INTO branch_service_offerings (status, price_minor, currency, duration_minutes, buffer_minutes,
             instructions_en, instructions_ar, created_by_user_id, clinic_id, branch_id, service_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, tenant.clinicId, branchId, serviceId],
        );
      else
        await t.execute(
          `UPDATE branch_service_offerings SET status = ?, price_minor = ?, currency = ?, duration_minutes = ?, buffer_minutes = ?,
             instructions_en = ?, instructions_ar = ?, updated_by_user_id = ? WHERE clinic_id = ? AND branch_id = ? AND service_id = ?`,
          [...values, tenant.clinicId, branchId, serviceId],
        );
      const after = await this.findOffering(tx, tenant, branchId, serviceId);
      if (after === undefined) throw new Error('offering vanished');
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.SERVICE_OFFERING_CHANGED,
          actor,
          tenant,
          targetType: 'SERVICE_OFFERING',
          targetId: String(after.id),
          metadata: {
            branchId,
            serviceId,
            status,
            before: before === undefined ? null : offeringTerms(before),
            after: offeringTerms(after),
          },
          event: 'service_offering.changed',
        },
        meta,
      );
      return { offering: toOffering(after), created: before === undefined };
    });
  }

  // ---------- doctor ↔ service ----------

  async listDoctorServices(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    filter: { status?: 'ACTIVE' | 'ENDED' | undefined },
  ) {
    const a = await loadAssignment(this.deps.db, tenant, assignmentId);
    const bt = await authorizeBranch(this.deps, actor, tenant, a.branch_id, 'clinic.services.view');
    const rows = await tenantExecutor(this.deps.db, bt.scope).query<Row>(
      `${DOCTOR_SERVICE_SELECT} WHERE d.clinic_id = ? AND d.assignment_id = ? AND (? IS NULL OR d.status = ?)
        ORDER BY d.id DESC LIMIT 500`,
      [bt.clinicId, assignmentId, filter.status ?? null, filter.status ?? null],
    );
    return rows.map(toDoctorService);
  }

  async listServiceDoctors(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    serviceId: string,
  ) {
    const bt = await authorizeBranch(this.deps, actor, tenant, branchId, 'clinic.services.view');
    const rows = await tenantExecutor(this.deps.db, bt.scope).query<Row>(
      `${DOCTOR_SERVICE_SELECT} WHERE d.clinic_id = ? AND d.branch_id = ? AND o.service_id = ? AND d.status = 'ACTIVE'
        ORDER BY d.id DESC LIMIT 500`,
      [bt.clinicId, branchId, serviceId],
    );
    return rows.map(toDoctorService);
  }

  /**
   * Idempotent: makes the doctor (assignment) eligible for the branch's offering of `serviceId`,
   * or updates the overrides of the active row. Requires an eligible assignment and an available
   * offering of THE SAME branch (also pinned by composite FKs).
   */
  async assignDoctorService(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    serviceId: string,
    input: { durationMinutes?: number | null | undefined; priceMinor?: number | null | undefined },
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'clinic.doctors.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      const now = this.deps.clock();
      const a = await loadAssignment(tx, tenant, assignmentId, true);
      assertConfigurable(a, now);
      const offering = await this.findOffering(tx, tenant, a.branch_id, serviceId);
      if (offering === undefined)
        throw new NotFoundError('The service is not offered at this branch');
      if (offering.status !== 'ACTIVE' || offering.service_status !== 'ACTIVE')
        throw new AppError(409, 'OFFERING_NOT_AVAILABLE', 'The service offering is inactive');
      const t = tenantExecutor(tx, tenant.scope);
      const active = (
        await t.query<Row>(
          `SELECT * FROM doctor_service_assignments WHERE clinic_id = ? AND assignment_id = ? AND offering_id = ? AND status = 'ACTIVE' FOR UPDATE`,
          [tenant.clinicId, assignmentId, String(offering.id)],
        )
      )[0];
      const duration = input.durationMinutes ?? null;
      const price = input.priceMinor ?? null;
      let id: string;
      if (active === undefined) {
        id = String(
          (
            await t.execute(
              `INSERT INTO doctor_service_assignments (clinic_id, branch_id, assignment_id, offering_id, duration_minutes, price_minor, created_by_user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                tenant.clinicId,
                a.branch_id,
                assignmentId,
                String(offering.id),
                duration,
                price,
                actor.userId,
              ],
            )
          ).insertId,
        );
      } else {
        id = String(active.id);
        await t.execute(
          'UPDATE doctor_service_assignments SET duration_minutes = ?, price_minor = ? WHERE id = ? AND clinic_id = ?',
          [duration, price, id, tenant.clinicId],
        );
      }
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.DOCTOR_SERVICE_CHANGED,
          actor,
          tenant,
          targetType: 'DOCTOR_SERVICE',
          targetId: id,
          metadata: {
            assignmentId,
            serviceId,
            offeringId: String(offering.id),
            status: 'ACTIVE',
            before:
              active === undefined
                ? null
                : { durationMinutes: active.duration_minutes, priceMinor: active.price_minor },
            after: { durationMinutes: duration, priceMinor: price },
          },
          event: 'doctor_service.changed',
        },
        meta,
      );
      const row = (
        await t.query<Row>(`${DOCTOR_SERVICE_SELECT} WHERE d.clinic_id = ? AND d.id = ?`, [
          tenant.clinicId,
          id,
        ])
      )[0];
      return { doctorService: toDoctorService(row ?? {}), created: active === undefined };
    });
  }

  async endDoctorService(
    actor: Principal,
    tenant: TenantContext,
    assignmentId: string,
    serviceId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'clinic.doctors.manage', { tenant });
    await this.deps.db.transaction(async (tx) => {
      await this.deps.lockClinic(tx, tenant.clinicId);
      const a = await loadAssignment(tx, tenant, assignmentId);
      const offering = await this.findOffering(tx, tenant, a.branch_id, serviceId);
      if (offering === undefined)
        throw new NotFoundError('The service is not offered at this branch');
      const t = tenantExecutor(tx, tenant.scope);
      const result = await t.execute(
        `UPDATE doctor_service_assignments SET status = 'ENDED', ended_at = ?, ended_by_user_id = ?
          WHERE clinic_id = ? AND assignment_id = ? AND offering_id = ? AND status = 'ACTIVE'`,
        [this.deps.clock(), actor.userId, tenant.clinicId, assignmentId, String(offering.id)],
      );
      if (result.affectedRows === 0)
        throw new NotFoundError('The doctor is not assigned to this service');
      await recordChange(
        this.deps,
        tx,
        {
          action: AUDIT_ACTION.DOCTOR_SERVICE_CHANGED,
          actor,
          tenant,
          targetType: 'DOCTOR_SERVICE',
          targetId: `${assignmentId}:${String(offering.id)}`,
          metadata: { assignmentId, serviceId, offeringId: String(offering.id), status: 'ENDED' },
          event: 'doctor_service.ended',
        },
        meta,
      );
    });
  }

  // ---------- helpers ----------

  private async loadService(
    executor: SqlExecutor,
    tenant: TenantContext,
    serviceId: string,
    forUpdate = false,
  ): Promise<Row> {
    const rows = await tenantExecutor(executor, tenant.scope).query<Row>(
      `SELECT * FROM clinic_services WHERE id = ? AND clinic_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [serviceId, tenant.clinicId],
    );
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('Service not found');
    return row;
  }

  private async findOffering(
    executor: SqlExecutor,
    tenant: TenantContext,
    branchId: string,
    serviceId: string,
    forUpdate = false,
  ): Promise<Row | undefined> {
    const rows = await tenantExecutor(executor, tenant.scope).query<Row>(
      `${OFFERING_SELECT} WHERE o.clinic_id = ? AND o.branch_id = ? AND o.service_id = ?${forUpdate ? ' FOR UPDATE OF o' : ''}`,
      [tenant.clinicId, branchId, serviceId],
    );
    return rows[0];
  }

  private async assertSpecialty(executor: SqlExecutor, code: string | null | undefined) {
    if (code === undefined || code === null) return;
    const rows = await executor.query(
      'SELECT code FROM specialties WHERE code = ? AND active = 1',
      [code],
    );
    if (rows.length === 0)
      throw new AppError(422, 'UNKNOWN_SPECIALTY', 'The specialty does not exist or is inactive');
  }

  private async assertCodeFree(
    executor: SqlExecutor,
    tenant: TenantContext,
    code: string | null | undefined,
    exceptId: string | null,
  ) {
    if (code === undefined || code === null) return;
    const rows = await tenantExecutor(executor, tenant.scope).query<{ id: string }>(
      'SELECT id FROM clinic_services WHERE clinic_id = ? AND code = ?',
      [tenant.clinicId, code],
    );
    if (rows.some((r) => r.id !== exceptId))
      throw new ConflictError('Another service of this clinic uses this code');
  }
}

function offeringTerms(r: Row) {
  return {
    status: r.status,
    priceMinor: Number(r.price_minor),
    currency: r.currency,
    durationMinutes: Number(r.duration_minutes),
    bufferMinutes: Number(r.buffer_minutes),
  };
}

function pick(view: ReturnType<typeof toService>, keys: readonly string[]) {
  const flat: Record<string, unknown> = {
    code: view.code,
    nameEn: view.name.en,
    nameAr: view.name.ar,
    descriptionEn: view.description.en,
    descriptionAr: view.description.ar,
    preparationEn: view.preparation.en,
    preparationAr: view.preparation.ar,
    specialtyCode: view.specialtyCode,
    status: view.status,
  };
  return Object.fromEntries(keys.map((k) => [k, flat[k]]));
}
