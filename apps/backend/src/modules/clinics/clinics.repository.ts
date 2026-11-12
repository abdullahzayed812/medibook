import type { SqlExecutor } from '../../infrastructure/database/database.js';
import type { OperationalStatus, SuspensionScope } from './operation-policy.js';

export const CLINIC_TYPES = [
  'GENERAL',
  'SPECIALTY',
  'DENTAL',
  'POLYCLINIC',
  'DIAGNOSTIC',
  'OTHER',
] as const;
export type ClinicType = (typeof CLINIC_TYPES)[number];

export interface Address {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface Clinic extends Address {
  readonly id: string;
  readonly name: string;
  readonly clinicType: ClinicType;
  readonly description: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly website: string | null;
  readonly legalName: string | null;
  readonly businessRegistrationNo: string | null;
  readonly taxId: string | null;
  readonly operationalStatus: OperationalStatus;
  readonly operationalStatusChangedAt: Date;
  readonly approvedAt: Date | null;
  readonly publicVisibility: boolean;
  readonly doctorsPublicVisibility: boolean;
  readonly servicesPublicVisibility: boolean;
  readonly createdAt: Date;
}

export interface Suspension {
  readonly id: string;
  readonly scope: SuspensionScope;
  readonly reason: string;
  readonly startsAt: Date;
  readonly expectedEndAt: Date | null;
  readonly suspendedByUserId: string;
  readonly endedAt: Date | null;
  readonly endedByUserId: string | null;
  readonly endReason: string | null;
}

/** Column ↔ field mapping for address columns (shared by clinics, branches, registrations). */
export const ADDRESS_COLUMNS = {
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  countryCode: 'country_code',
  latitude: 'latitude',
  longitude: 'longitude',
} as const;

type Row = Record<string, unknown>;

export function addressFromRow(r: Row): Address {
  return {
    addressLine1: (r.address_line1 as string | null) ?? null,
    addressLine2: (r.address_line2 as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    region: (r.region as string | null) ?? null,
    postalCode: (r.postal_code as string | null) ?? null,
    countryCode: (r.country_code as string | null) ?? null,
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
  };
}

function toClinic(r: Row): Clinic {
  return {
    id: String(r.id),
    name: r.name as string,
    clinicType: r.clinic_type as ClinicType,
    description: (r.description as string | null) ?? null,
    contactPhone: (r.contact_phone as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    website: (r.website as string | null) ?? null,
    ...addressFromRow(r),
    legalName: (r.legal_name as string | null) ?? null,
    businessRegistrationNo: (r.business_registration_no as string | null) ?? null,
    taxId: (r.tax_id as string | null) ?? null,
    operationalStatus: r.operational_status as OperationalStatus,
    operationalStatusChangedAt: r.operational_status_changed_at as Date,
    approvedAt: (r.approved_at as Date | null) ?? null,
    publicVisibility: Number(r.public_visibility) === 1,
    doctorsPublicVisibility: Number(r.doctors_public_visibility) === 1,
    servicesPublicVisibility: Number(r.services_public_visibility) === 1,
    createdAt: r.created_at as Date,
  };
}

function toSuspension(r: Row): Suspension {
  return {
    id: String(r.id),
    scope: r.scope as SuspensionScope,
    reason: r.reason as string,
    startsAt: r.starts_at as Date,
    expectedEndAt: (r.expected_end_at as Date | null) ?? null,
    suspendedByUserId: String(r.suspended_by_user_id),
    endedAt: (r.ended_at as Date | null) ?? null,
    endedByUserId: typeof r.ended_by_user_id === 'string' ? r.ended_by_user_id : null,
    endReason: (r.end_reason as string | null) ?? null,
  };
}

/**
 * Raw SQL for the clinics table and its lifecycle tables. The clinic row is addressed by the
 * clinic id that the CALLER already authorized (verified ClinicScope.clinicId for clinic actors,
 * or an explicit platform permission for Super Admins).
 */
export class ClinicsRepository {
  async find(
    executor: SqlExecutor,
    clinicId: string,
    forUpdate = false,
  ): Promise<Clinic | undefined> {
    const rows = await executor.query<Row>(
      `SELECT * FROM clinics WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [clinicId],
    );
    return rows[0] === undefined ? undefined : toClinic(rows[0]);
  }

  async list(
    executor: SqlExecutor,
    filter: {
      operationalStatus?: OperationalStatus | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): Promise<Clinic[]> {
    const rows = await executor.query<Row>(
      `SELECT * FROM clinics WHERE (? IS NULL OR operational_status = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      [
        filter.operationalStatus ?? null,
        filter.operationalStatus ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return rows.map(toClinic);
  }

  /** Dynamic SET from a fixed allow-list of columns (never user-supplied column names). */
  async update(
    executor: SqlExecutor,
    clinicId: string,
    columns: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    const entries = Object.entries(columns);
    if (entries.length === 0) return;
    await executor.execute(
      `UPDATE clinics SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...entries.map(([, v]) => v), clinicId],
    );
  }

  async setOperationalStatus(
    executor: SqlExecutor,
    clinicId: string,
    status: OperationalStatus,
    now: Date,
  ): Promise<void> {
    await executor.execute(
      'UPDATE clinics SET operational_status = ?, operational_status_changed_at = ? WHERE id = ?',
      [status, now, clinicId],
    );
  }

  async insertHistory(
    executor: SqlExecutor,
    input: {
      clinicId: string;
      from: OperationalStatus | null;
      to: OperationalStatus;
      actorUserId: string | null;
      reason: string | null;
      referenceType?: string;
      referenceId?: string;
    },
  ): Promise<void> {
    await executor.execute(
      'INSERT INTO clinic_lifecycle_history (clinic_id, from_status, to_status, actor_user_id, reason, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        input.clinicId,
        input.from,
        input.to,
        input.actorUserId,
        input.reason,
        input.referenceType ?? null,
        input.referenceId ?? null,
      ],
    );
  }

  async listHistory(executor: SqlExecutor, clinicId: string) {
    return executor.query<{
      id: string;
      from_status: string | null;
      to_status: string;
      actor_user_id: string | null;
      reason: string | null;
      reference_type: string | null;
      reference_id: string | null;
      created_at: Date;
    }>(
      'SELECT id, from_status, to_status, actor_user_id, reason, reference_type, reference_id, created_at FROM clinic_lifecycle_history WHERE clinic_id = ? ORDER BY id',
      [clinicId],
    );
  }

  async openSuspension(
    executor: SqlExecutor,
    clinicId: string,
    forUpdate = false,
  ): Promise<Suspension | undefined> {
    const rows = await executor.query<Row>(
      `SELECT * FROM clinic_suspensions WHERE clinic_id = ? AND ended_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`,
      [clinicId],
    );
    return rows[0] === undefined ? undefined : toSuspension(rows[0]);
  }

  async listSuspensions(executor: SqlExecutor, clinicId: string): Promise<Suspension[]> {
    return (
      await executor.query<Row>(
        'SELECT * FROM clinic_suspensions WHERE clinic_id = ? ORDER BY id',
        [clinicId],
      )
    ).map(toSuspension);
  }

  async hasActiveAccessException(
    executor: SqlExecutor,
    clinicId: string,
    suspensionId: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await executor.query<{ id: string }>(
      `SELECT id FROM clinic_access_exceptions
        WHERE clinic_id = ? AND suspension_id = ? AND user_id = ? AND revoked_at IS NULL AND starts_at <= ? AND expires_at > ?
        LIMIT 1`,
      [clinicId, suspensionId, userId, now, now],
    );
    return rows.length > 0;
  }

  async branchStatus(
    executor: SqlExecutor,
    clinicId: string,
    branchId: string,
  ): Promise<'ACTIVE' | 'INACTIVE' | null> {
    const rows = await executor.query<{ status: 'ACTIVE' | 'INACTIVE' }>(
      'SELECT status FROM clinic_branches WHERE id = ? AND clinic_id = ?',
      [branchId, clinicId],
    );
    return rows[0]?.status ?? null;
  }
}
