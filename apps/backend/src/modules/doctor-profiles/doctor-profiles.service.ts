import { z } from 'zod';
import { toIsoDate } from '../../shared/must.js';
import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import { defineStateMachine } from '../../shared/state-machine.js';
import type { AuthorizationService, Principal } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { DocumentMetadata, PrivateDocuments } from '../platform/index.js';

export const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'PENDING_REVIEW',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_LIFECYCLE = defineStateMachine<VerificationStatus>(
  'Doctor verification',
  {
    UNVERIFIED: ['PENDING_REVIEW'],
    PENDING_REVIEW: ['VERIFIED', 'REJECTED'],
    VERIFIED: ['SUSPENDED'],
    REJECTED: ['PENDING_REVIEW'],
    SUSPENDED: ['VERIFIED', 'REJECTED'],
  },
);

export const VERIFICATION_DECISIONS = {
  APPROVE: 'VERIFIED',
  REJECT: 'REJECTED',
  SUSPEND: 'SUSPENDED',
  REINSTATE: 'VERIFIED',
} as const;
export type VerificationDecision = keyof typeof VERIFICATION_DECISIONS;

/** License data is frozen while under review or verified; changing it requires re-verification. */
export const LICENSE_EDITABLE: readonly VerificationStatus[] = ['UNVERIFIED', 'REJECTED'];

const qualification = z
  .object({
    title: z.string().trim().min(1).max(200),
    institution: z.string().trim().max(200).optional(),
    year: z.number().int().min(1900).max(2100).optional(),
  })
  .strict();

export const doctorProfileInputSchema = z
  .object({
    displayName: z.string().trim().min(2).max(150),
    bio: z.string().trim().max(5000).nullable().optional(),
    qualifications: z.array(qualification).max(20).optional(),
    specialties: z
      .array(
        z
          .object({
            code: z.string().regex(/^[a-z0-9]+(_[a-z0-9]+)*$/),
            primary: z.boolean().optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    licenseNumber: z.string().trim().min(2).max(64).nullable().optional(),
    licenseAuthority: z.string().trim().min(2).max(200).nullable().optional(),
    licenseCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .optional(),
    licenseExpiresOn: z.iso.date().nullable().optional(),
    publicVisibility: z.boolean().optional(),
    profileStatus: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .strict();
export const doctorProfilePatchSchema = doctorProfileInputSchema.partial().strict();
export type DoctorProfileInput = z.infer<typeof doctorProfileInputSchema>;

const LICENSE_FIELDS = [
  'licenseNumber',
  'licenseAuthority',
  'licenseCountry',
  'licenseExpiresOn',
] as const;
const COLUMNS: Readonly<Record<string, string>> = {
  displayName: 'display_name',
  bio: 'bio',
  licenseNumber: 'license_number',
  licenseAuthority: 'license_authority',
  licenseCountry: 'license_country',
  licenseExpiresOn: 'license_expires_on',
  publicVisibility: 'public_visibility',
  profileStatus: 'profile_status',
};

type Row = Record<string, unknown>;

/** Full (private) profile: owner and platform reviewers only. */
function toProfile(r: Row, specialties: { code: string; name: string; primary: boolean }[]) {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    displayName: r.display_name as string,
    bio: (r.bio as string | null) ?? null,
    qualifications: (r.qualifications as unknown[] | null) ?? [],
    specialties,
    licenseNumber: (r.license_number as string | null) ?? null,
    licenseAuthority: (r.license_authority as string | null) ?? null,
    licenseCountry: (r.license_country as string | null) ?? null,
    licenseExpiresOn: toIsoDate(r.license_expires_on),
    publicVisibility: Number(r.public_visibility) === 1,
    verificationStatus: r.verification_status as VerificationStatus,
    verificationChangedAt: r.verification_changed_at as Date,
    profileStatus: r.profile_status as 'ACTIVE' | 'INACTIVE',
    createdAt: r.created_at as Date,
  };
}
export type DoctorProfileView = ReturnType<typeof toProfile>;

/** What the public may see. Never license numbers, documents, verification notes or contact data. */
export function toPublicDoctor(p: DoctorProfileView) {
  return {
    id: p.id,
    displayName: p.displayName,
    bio: p.bio,
    qualifications: p.qualifications,
    specialties: p.specialties,
    verified: p.verificationStatus === 'VERIFIED',
  };
}

export interface DoctorProfileDeps {
  readonly db: Database;
  readonly authz: AuthorizationService;
  readonly documents: PrivateDocuments;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
}

/**
 * Global doctor professional profile: one per user, owned by the doctor (not by any clinic).
 * Clinic managers cannot change it; only platform reviewers (platform.doctors.verify) change the
 * verification status. Verification never grants clinic membership or permissions.
 */
export class DoctorProfileService {
  constructor(private readonly deps: DoctorProfileDeps) {}

  async createOwn(
    actor: Principal,
    input: DoctorProfileInput,
    meta: RequestMeta,
  ): Promise<DoctorProfileView> {
    return this.deps.db.transaction(async (tx) => {
      const existing = await tx.query(
        'SELECT id FROM doctor_profiles WHERE user_id = ? FOR UPDATE',
        [actor.userId],
      );
      if (existing.length > 0)
        throw new ConflictError('A doctor profile already exists for this account');
      const { specialties, qualifications, ...rest } = input;
      const columns = toColumns(rest);
      const entries = Object.entries(columns);
      const id = String(
        (
          await tx.execute(
            `INSERT INTO doctor_profiles (user_id, qualifications, ${entries.map(([c]) => c).join(', ')}) VALUES (?, ?, ${entries.map(() => '?').join(', ')})`,
            [actor.userId, JSON.stringify(qualifications ?? []), ...entries.map(([, v]) => v)],
          )
        ).insertId,
      );
      if (specialties !== undefined) await this.replaceSpecialties(tx, id, specialties);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.DOCTOR_PROFILE_CREATED,
          actorUserId: actor.userId,
          targetType: 'DOCTOR_PROFILE',
          targetId: id,
        },
        meta,
      );
      return this.load(tx, { id });
    });
  }

  async getOwn(actor: Principal) {
    const profile = await this.load(this.deps.db, { userId: actor.userId });
    return {
      profile,
      documents: await this.deps.documents.list(this.deps.db, profile.id),
      history: await this.history(this.deps.db, profile.id),
    };
  }

  async updateOwn(
    actor: Principal,
    patch: Partial<DoctorProfileInput>,
    meta: RequestMeta,
  ): Promise<DoctorProfileView> {
    return this.deps.db.transaction(async (tx) => {
      const profile = await this.load(tx, { userId: actor.userId }, true);
      const touchesLicense = LICENSE_FIELDS.some((f) => patch[f] !== undefined);
      if (touchesLicense && !LICENSE_EDITABLE.includes(profile.verificationStatus)) {
        throw new AppError(
          409,
          'LICENSE_LOCKED',
          'License details cannot change while under review or verified',
        );
      }
      const { specialties, qualifications, ...rest } = patch;
      const columns: Record<string, string | number | boolean | null> = toColumns(rest);
      if (qualifications !== undefined) columns.qualifications = JSON.stringify(qualifications);
      const entries = Object.entries(columns);
      if (entries.length > 0) {
        await tx.execute(
          `UPDATE doctor_profiles SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
          [...entries.map(([, v]) => v), profile.id],
        );
      }
      if (specialties !== undefined) await this.replaceSpecialties(tx, profile.id, specialties);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.DOCTOR_PROFILE_UPDATED,
          actorUserId: actor.userId,
          targetType: 'DOCTOR_PROFILE',
          targetId: profile.id,
          metadata: { changed: Object.keys(patch) },
        },
        meta,
      );
      return this.load(tx, { id: profile.id });
    });
  }

  async uploadDocument(
    actor: Principal,
    input: Parameters<PrivateDocuments['upload']>[3],
    meta: RequestMeta,
  ): Promise<DocumentMetadata> {
    return this.deps.db.transaction(async (tx) => {
      const profile = await this.load(tx, { userId: actor.userId }, true);
      if (!LICENSE_EDITABLE.includes(profile.verificationStatus))
        throw new ConflictError('Documents can be added before submitting for verification');
      const doc = await this.deps.documents.upload(tx, profile.id, actor.userId, input);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.DOCUMENT_UPLOADED,
          actorUserId: actor.userId,
          targetType: 'DOCUMENT',
          targetId: doc.id,
          metadata: { parent: 'DOCTOR_PROFILE', parentId: profile.id, type: doc.documentType },
        },
        meta,
      );
      return doc;
    });
  }

  async readOwnDocument(actor: Principal, documentId: string) {
    const profile = await this.load(this.deps.db, { userId: actor.userId });
    return this.deps.documents.read(this.deps.db, profile.id, documentId);
  }

  async submitForVerification(actor: Principal, meta: RequestMeta): Promise<DoctorProfileView> {
    return this.deps.db.transaction(async (tx) => {
      const profile = await this.load(tx, { userId: actor.userId }, true);
      VERIFICATION_LIFECYCLE.assert(profile.verificationStatus, 'PENDING_REVIEW');
      const docs = await this.deps.documents.list(tx, profile.id);
      const missing = [
        ...(profile.licenseNumber === null ? ['licenseNumber'] : []),
        ...(profile.licenseAuthority === null ? ['licenseAuthority'] : []),
        ...(docs.some((d) => d.documentType === 'MEDICAL_LICENSE')
          ? []
          : ['MEDICAL_LICENSE document']),
      ];
      if (missing.length > 0)
        throw new AppError(422, 'VERIFICATION_INCOMPLETE', 'Verification request is incomplete', {
          details: { missing },
        });
      await this.setStatus(tx, profile, 'PENDING_REVIEW', actor.userId, null, meta);
      return this.load(tx, { id: profile.id });
    });
  }

  // ---------- Super Admin ----------

  async listForReview(
    actor: Principal,
    filter: { status?: VerificationStatus | undefined; limit: number; cursor?: string | undefined },
  ) {
    await this.deps.authz.assert(actor, 'platform.doctors.verify');
    const rows = await this.deps.db.query<Row>(
      'SELECT * FROM doctor_profiles WHERE (? IS NULL OR verification_status = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',
      [
        filter.status ?? null,
        filter.status ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    const specialties = await this.specialtiesFor(
      this.deps.db,
      rows.map((r) => String(r.id)),
    );
    return toPage(
      rows.map((r) => toProfile(r, specialties.get(String(r.id)) ?? [])),
      filter.limit,
    );
  }

  async getForReview(actor: Principal, profileId: string) {
    await this.deps.authz.assert(actor, 'platform.doctors.verify');
    const profile = await this.load(this.deps.db, { id: profileId });
    return {
      profile,
      documents: await this.deps.documents.list(this.deps.db, profileId, true),
      history: await this.history(this.deps.db, profileId),
    };
  }

  async readDocumentForReview(
    actor: Principal,
    profileId: string,
    documentId: string,
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'platform.doctors.verify');
    const doc = await this.deps.documents.read(this.deps.db, profileId, documentId);
    await this.deps.auditLog.record(
      this.deps.db,
      {
        action: AUDIT_ACTION.DOCUMENT_ACCESSED,
        actorUserId: actor.userId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        metadata: { parent: 'DOCTOR_PROFILE', parentId: profileId },
      },
      meta,
    );
    return doc;
  }

  async decide(
    actor: Principal,
    profileId: string,
    decision: VerificationDecision,
    reason: string,
    meta: RequestMeta,
  ): Promise<DoctorProfileView> {
    await this.deps.authz.assert(actor, 'platform.doctors.verify');
    return this.deps.db.transaction(async (tx) => {
      const profile = await this.load(tx, { id: profileId }, true);
      if (profile.userId === actor.userId)
        throw new AppError(
          403,
          'SELF_APPROVAL_FORBIDDEN',
          'You cannot review your own professional verification',
        );
      const to = VERIFICATION_DECISIONS[decision];
      if (decision === 'REINSTATE' && profile.verificationStatus !== 'SUSPENDED')
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          'Only suspended verifications can be reinstated',
        );
      if (decision === 'APPROVE' && profile.verificationStatus !== 'PENDING_REVIEW')
        throw new AppError(409, 'INVALID_TRANSITION', 'Only pending verifications can be approved');
      await this.setStatus(tx, profile, to, actor.userId, reason, meta);
      return this.load(tx, { id: profileId });
    });
  }

  /** Used by the marketplace: profile by id, or undefined. */
  async findById(executor: SqlExecutor, profileId: string): Promise<DoctorProfileView | undefined> {
    try {
      return await this.load(executor, { id: profileId });
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  // ---------- internals ----------

  private async setStatus(
    tx: SqlExecutor,
    profile: DoctorProfileView,
    to: VerificationStatus,
    actorUserId: string,
    reason: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    VERIFICATION_LIFECYCLE.assert(profile.verificationStatus, to);
    await tx.execute(
      'UPDATE doctor_profiles SET verification_status = ?, verification_changed_at = ? WHERE id = ?',
      [to, this.deps.clock(), profile.id],
    );
    await tx.execute(
      'INSERT INTO doctor_verification_history (doctor_profile_id, from_status, to_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)',
      [profile.id, profile.verificationStatus, to, actorUserId, reason],
    );
    await this.deps.auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.DOCTOR_VERIFICATION_CHANGED,
        actorUserId,
        targetType: 'DOCTOR_PROFILE',
        targetId: profile.id,
        metadata: { from: profile.verificationStatus, to, reason },
      },
      meta,
    );
  }

  private async replaceSpecialties(
    tx: SqlExecutor,
    profileId: string,
    specialties: readonly { code: string; primary?: boolean | undefined }[],
  ): Promise<void> {
    if (specialties.filter((s) => s.primary === true).length > 1)
      throw new ValidationError([
        { location: 'body', path: 'specialties', message: 'At most one primary specialty' },
      ]);
    const codes = [...new Set(specialties.map((s) => s.code))];
    if (codes.length > 0) {
      const known = await tx.query<{ code: string }>(
        `SELECT code FROM specialties WHERE active = 1 AND code IN (${codes.map(() => '?').join(', ')})`,
        codes,
      );
      if (known.length !== codes.length)
        throw new ValidationError([
          { location: 'body', path: 'specialties', message: 'Unknown or inactive specialty' },
        ]);
    }
    await tx.execute('DELETE FROM doctor_specialties WHERE doctor_profile_id = ?', [profileId]);
    for (const s of specialties) {
      await tx.execute(
        'INSERT IGNORE INTO doctor_specialties (doctor_profile_id, specialty_code, is_primary) VALUES (?, ?, ?)',
        [profileId, s.code, s.primary === true ? 1 : 0],
      );
    }
  }

  private async specialtiesFor(
    executor: SqlExecutor,
    profileIds: readonly string[],
  ): Promise<Map<string, { code: string; name: string; primary: boolean }[]>> {
    const map = new Map<string, { code: string; name: string; primary: boolean }[]>();
    if (profileIds.length === 0) return map;
    const rows = await executor.query<{
      doctor_profile_id: string;
      code: string;
      name: string;
      is_primary: number;
    }>(
      `SELECT ds.doctor_profile_id, s.code, s.name, ds.is_primary FROM doctor_specialties ds JOIN specialties s ON s.code = ds.specialty_code
        WHERE ds.doctor_profile_id IN (${profileIds.map(() => '?').join(', ')}) ORDER BY ds.is_primary DESC, s.name`,
      profileIds,
    );
    for (const r of rows) {
      const list = map.get(r.doctor_profile_id) ?? [];
      list.push({ code: r.code, name: r.name, primary: r.is_primary === 1 });
      map.set(r.doctor_profile_id, list);
    }
    return map;
  }

  private async load(
    executor: SqlExecutor,
    key: { id: string } | { userId: string },
    forUpdate = false,
  ): Promise<DoctorProfileView> {
    const [column, value] = 'id' in key ? ['id', key.id] : ['user_id', key.userId];
    const rows = await executor.query<Row>(
      `SELECT * FROM doctor_profiles WHERE ${column} = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [value],
    );
    if (rows[0] === undefined) throw new NotFoundError('Doctor profile not found');
    const id = String(rows[0].id);
    return toProfile(rows[0], (await this.specialtiesFor(executor, [id])).get(id) ?? []);
  }

  private async history(executor: SqlExecutor, profileId: string) {
    return executor.query(
      'SELECT id, from_status AS fromStatus, to_status AS toStatus, actor_user_id AS actorUserId, reason, created_at AS createdAt FROM doctor_verification_history WHERE doctor_profile_id = ? ORDER BY id',
      [profileId],
    );
  }
}

function toColumns(
  fields: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const columns: Record<string, string | number | boolean | null> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const column = COLUMNS[field];
    if (column === undefined) throw new Error(`Unmapped field ${field}`);
    columns[column] =
      typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number | null);
  }
  return columns;
}

/**
 * Specialty catalog. Listing active specialties is public; creating, renaming and deactivating
 * (the catalog's soft delete) require `platform.specialties.manage`, which is deliberately
 * separate from `platform.doctors.verify` (reviewing doctors is not curating the catalog).
 */
export class SpecialtyService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthorizationService,
    private readonly auditLog: AuditLog,
  ) {}

  listActive() {
    return this.db.query<{ code: string; name: string }>(
      'SELECT code, name FROM specialties WHERE active = 1 ORDER BY name',
    );
  }

  async upsert(
    actor: Principal,
    input: { code: string; name: string; active?: boolean | undefined },
    meta: RequestMeta,
  ): Promise<void> {
    await this.authz.assert(actor, 'platform.specialties.manage');
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO specialties (code, name, active) VALUES (?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE name = new.name, active = new.active`,
        [input.code, input.name, input.active === false ? 0 : 1],
      );
      await this.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.SPECIALTY_CHANGED,
          actorUserId: actor.userId,
          targetType: 'SPECIALTY',
          targetId: input.code,
          metadata: input,
        },
        meta,
      );
    });
  }
}
