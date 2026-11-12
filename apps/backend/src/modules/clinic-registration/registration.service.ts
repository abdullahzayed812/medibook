import { must } from '../../shared/must.js';
import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import type { AuthorizationService, MembershipsRepository, Principal } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { BranchesRepository } from '../clinics/branches.repository.js';
import type {
  DocumentMetadata,
  DomainEventOutbox,
  PlatformSettingsService,
  PrivateDocuments,
} from '../platform/index.js';
import type { BillingCycle, SubscriptionService } from '../subscriptions/index.js';
import {
  EDITABLE_STATUSES,
  isApplicantTransition,
  missingForSubmission,
  OPEN_STATUSES,
  REGISTRATION_COLUMNS,
  REGISTRATION_LIFECYCLE,
  type RegistrationFields,
  type RegistrationRequest,
  type RegistrationStatus,
} from './registration.js';

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** mysql2 returns VARCHAR and BIGINT (bigNumberStrings) columns as strings. */
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toRequest(r: Row): RegistrationRequest {
  return {
    id: String(r.id),
    ownerUserId: String(r.owner_user_id),
    status: r.status as RegistrationStatus,
    clinicName: r.clinic_name as string,
    clinicType: r.clinic_type as string,
    description: str(r.description),
    contactPhone: str(r.contact_phone),
    contactEmail: str(r.contact_email),
    website: str(r.website),
    addressLine1: str(r.address_line1),
    addressLine2: str(r.address_line2),
    city: str(r.city),
    region: str(r.region),
    postalCode: str(r.postal_code),
    countryCode: str(r.country_code),
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    legalName: str(r.legal_name),
    businessRegistrationNo: str(r.business_registration_no),
    taxId: str(r.tax_id),
    submittedAt: (r.submitted_at as Date | null) ?? null,
    decidedAt: (r.decided_at as Date | null) ?? null,
    decidedByUserId: str(r.decided_by_user_id),
    decisionReason: str(r.decision_reason),
    clinicId: str(r.clinic_id),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export interface RegistrationDeps {
  readonly db: Database;
  readonly authz: AuthorizationService;
  readonly documents: PrivateDocuments;
  readonly memberships: MembershipsRepository;
  readonly branches: BranchesRepository;
  readonly subscriptions: SubscriptionService;
  readonly settings: PlatformSettingsService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
  readonly clock: Clock;
}

/**
 * Clinic registration: applicant drafts and submits; Super Admins review and decide.
 * Applicant methods address requests by (id, owner) so foreign ids are "not found".
 * Admin methods require platform.registrations.review (MFA) and forbid self-decisions.
 */
export class RegistrationService {
  constructor(private readonly deps: RegistrationDeps) {}

  // ---------- applicant ----------

  async createDraft(
    actor: Principal,
    fields: RegistrationFields,
    meta: RequestMeta,
  ): Promise<RegistrationRequest> {
    return this.deps.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [actor.userId]); // serialize the open-request limit
      const max = await this.deps.settings.get('registration.max_open_requests_per_user', tx);
      const open = await tx.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM clinic_registration_requests WHERE owner_user_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(', ')})`,
        [actor.userId, ...OPEN_STATUSES],
      );
      if (Number(open[0]?.n ?? 0) >= max)
        throw new ConflictError(`At most ${max} open registration requests are allowed`);
      const columns = toColumns(fields);
      const entries = Object.entries(columns);
      const id = String(
        (
          await tx.execute(
            `INSERT INTO clinic_registration_requests (owner_user_id, ${entries.map(([c]) => c).join(', ')}) VALUES (?, ${entries.map(() => '?').join(', ')})`,
            [actor.userId, ...entries.map(([, v]) => v)],
          )
        ).insertId,
      );
      await this.history(tx, id, null, 'DRAFT', actor.userId, null);
      await this.audit(tx, AUDIT_ACTION.REGISTRATION_CREATED, actor.userId, id, meta, {
        clinicName: fields.clinicName,
      });
      return this.mustFind(tx, id);
    });
  }

  async listMine(actor: Principal): Promise<RegistrationRequest[]> {
    const rows = await this.deps.db.query<Row>(
      'SELECT * FROM clinic_registration_requests WHERE owner_user_id = ? ORDER BY id DESC',
      [actor.userId],
    );
    return rows.map(toRequest);
  }

  async getMine(actor: Principal, id: string) {
    const request = await this.ownRequest(this.deps.db, actor, id);
    return {
      request,
      documents: await this.deps.documents.list(this.deps.db, id),
      history: await this.listHistory(this.deps.db, id),
    };
  }

  async update(
    actor: Principal,
    id: string,
    patch: Partial<RegistrationFields>,
    meta: RequestMeta,
  ): Promise<RegistrationRequest> {
    return this.deps.db.transaction(async (tx) => {
      const request = await this.ownRequest(tx, actor, id, true);
      this.assertEditable(request);
      const columns = toColumns(patch);
      const entries = Object.entries(columns);
      if (entries.length > 0) {
        await tx.execute(
          `UPDATE clinic_registration_requests SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ? AND owner_user_id = ?`,
          [...entries.map(([, v]) => v), id, actor.userId],
        );
      }
      await this.audit(tx, AUDIT_ACTION.REGISTRATION_UPDATED, actor.userId, id, meta, {
        changed: Object.keys(patch),
      });
      return this.mustFind(tx, id);
    });
  }

  async submit(actor: Principal, id: string, meta: RequestMeta): Promise<RegistrationRequest> {
    return this.deps.db.transaction(async (tx) => {
      const request = await this.ownRequest(tx, actor, id, true);
      this.assertApplicantTransition(request.status, 'PENDING_REVIEW');
      const missing = missingForSubmission(request, await this.deps.documents.countActive(tx, id));
      if (missing.length > 0)
        throw new AppError(422, 'REGISTRATION_INCOMPLETE', 'The registration is incomplete', {
          details: { missing },
        });
      await tx.execute(
        `UPDATE clinic_registration_requests SET status = 'PENDING_REVIEW', submitted_at = ? WHERE id = ?`,
        [this.deps.clock(), id],
      );
      await this.history(tx, id, request.status, 'PENDING_REVIEW', actor.userId, null);
      await this.audit(tx, AUDIT_ACTION.REGISTRATION_STATUS_CHANGED, actor.userId, id, meta, {
        from: request.status,
        to: 'PENDING_REVIEW',
      });
      await this.deps.outbox.record(tx, {
        type: 'registration.submitted',
        aggregateType: 'registration',
        aggregateId: id,
      });
      return this.mustFind(tx, id);
    });
  }

  async uploadDocument(
    actor: Principal,
    id: string,
    input: Parameters<PrivateDocuments['upload']>[3],
    meta: RequestMeta,
  ): Promise<DocumentMetadata> {
    return this.deps.db.transaction(async (tx) => {
      const request = await this.ownRequest(tx, actor, id, true);
      this.assertEditable(request);
      const doc = await this.deps.documents.upload(tx, id, actor.userId, input);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.DOCUMENT_UPLOADED,
          actorUserId: actor.userId,
          targetType: 'DOCUMENT',
          targetId: doc.id,
          metadata: {
            parent: 'REGISTRATION',
            parentId: id,
            type: doc.documentType,
            sha256: doc.sha256,
          },
        },
        meta,
      );
      return doc;
    });
  }

  async removeDocument(
    actor: Principal,
    id: string,
    documentId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const request = await this.ownRequest(tx, actor, id, true);
      this.assertEditable(request);
      await this.deps.documents.remove(tx, id, documentId, this.deps.clock());
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.DOCUMENT_REMOVED,
          actorUserId: actor.userId,
          targetType: 'DOCUMENT',
          targetId: documentId,
          metadata: { parent: 'REGISTRATION', parentId: id },
        },
        meta,
      );
    });
  }

  async readOwnDocument(actor: Principal, id: string, documentId: string) {
    await this.ownRequest(this.deps.db, actor, id);
    return this.deps.documents.read(this.deps.db, id, documentId);
  }

  // ---------- Super Admin ----------

  async list(
    actor: Principal,
    filter: {
      status?: RegistrationStatus | undefined;
      sort: 'submitted_asc' | 'newest';
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    await this.deps.authz.assert(actor, 'platform.registrations.review');
    // Drafts are private to the applicant until submitted.
    const order = filter.sort === 'submitted_asc' ? 'ASC' : 'DESC';
    const cursorCmp = order === 'ASC' ? '>' : '<';
    const rows = await this.deps.db.query<Row>(
      `SELECT * FROM clinic_registration_requests
        WHERE status <> 'DRAFT' AND (? IS NULL OR status = ?) AND (? IS NULL OR id ${cursorCmp} ?)
        ORDER BY id ${order} LIMIT ?`,
      [
        filter.status ?? null,
        filter.status ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return toPage(rows.map(toRequest), filter.limit);
  }

  async getForReview(actor: Principal, id: string) {
    await this.deps.authz.assert(actor, 'platform.registrations.review');
    const request = await this.reviewable(this.deps.db, id);
    return {
      request,
      documents: await this.deps.documents.list(this.deps.db, id, true),
      history: await this.listHistory(this.deps.db, id),
    };
  }

  /** Document access by reviewers is audited. */
  async readDocumentForReview(actor: Principal, id: string, documentId: string, meta: RequestMeta) {
    await this.deps.authz.assert(actor, 'platform.registrations.review');
    await this.reviewable(this.deps.db, id);
    const doc = await this.deps.documents.read(this.deps.db, id, documentId);
    await this.deps.auditLog.record(
      this.deps.db,
      {
        action: AUDIT_ACTION.DOCUMENT_ACCESSED,
        actorUserId: actor.userId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        metadata: { parent: 'REGISTRATION', parentId: id },
      },
      meta,
    );
    return doc;
  }

  startReview(actor: Principal, id: string, meta: RequestMeta) {
    return this.decide(actor, id, 'UNDER_REVIEW', null, meta);
  }

  requestInformation(actor: Principal, id: string, reason: string, meta: RequestMeta) {
    return this.decide(actor, id, 'NEEDS_INFORMATION', reason, meta);
  }

  reject(actor: Principal, id: string, reason: string, meta: RequestMeta) {
    return this.decide(actor, id, 'REJECTED', reason, meta);
  }

  suspend(actor: Principal, id: string, reason: string, meta: RequestMeta) {
    return this.decide(actor, id, 'SUSPENDED', reason, meta);
  }

  resume(actor: Principal, id: string, reason: string, meta: RequestMeta) {
    return this.decide(actor, id, 'UNDER_REVIEW', reason, meta, 'SUSPENDED');
  }

  /**
   * Approval, atomically: clinic (ACTIVE, approved), main branch, CLINIC_OWNER membership for the
   * applicant (all branches), subscription (trial per plan), request APPROVED + history + audit +
   * outbox. Nothing exists operationally before this commits.
   */
  async approve(
    actor: Principal,
    id: string,
    input: { planId: string; billingCycle: BillingCycle; reason?: string | undefined },
    meta: RequestMeta,
  ) {
    await this.deps.authz.assert(actor, 'platform.registrations.review');
    return this.deps.db.transaction(async (tx) => {
      const request = await this.lockForDecision(tx, actor, id);
      REGISTRATION_LIFECYCLE.assert(request.status, 'APPROVED');
      const owner = await tx.query<{ status: string; phone_verified_at: Date | null }>(
        'SELECT status, phone_verified_at FROM users WHERE id = ? FOR UPDATE',
        [request.ownerUserId],
      );
      if (owner[0]?.status !== 'ACTIVE' || owner[0].phone_verified_at === null) {
        throw new ConflictError('The applicant account is not active and verified');
      }
      const now = this.deps.clock();
      const clinicId = String(
        (
          await tx.execute(
            `INSERT INTO clinics (name, clinic_type, description, contact_phone, contact_email, website, address_line1, address_line2,
               city, region, postal_code, country_code, latitude, longitude, legal_name, business_registration_no, tax_id,
               operational_status, operational_status_changed_at, approved_at, approved_by_user_id)
             SELECT clinic_name, clinic_type, description, contact_phone, contact_email, website, address_line1, address_line2,
               city, region, postal_code, country_code, latitude, longitude, legal_name, business_registration_no, tax_id,
               'ACTIVE', ?, ?, ? FROM clinic_registration_requests WHERE id = ?`,
            [now, now, actor.userId, id],
          )
        ).insertId,
      );
      const branchId = await this.deps.branches.insertInitial(tx, clinicId, {
        name: request.clinicName,
        address_line1: request.addressLine1,
        address_line2: request.addressLine2,
        city: request.city,
        region: request.region,
        postal_code: request.postalCode,
        country_code: request.countryCode,
        latitude: request.latitude,
        longitude: request.longitude,
        contact_phone: request.contactPhone,
        contact_email: request.contactEmail,
      });
      const membershipId = await this.deps.memberships.insert(tx, {
        clinicId,
        userId: request.ownerUserId,
        role: 'CLINIC_OWNER',
        branchScope: 'ALL',
        effectiveFrom: null,
        effectiveUntil: null,
        createdBy: actor.userId,
        now,
      });
      await this.deps.memberships.insertEvent(tx, {
        membershipId,
        clinicId,
        fromStatus: null,
        toStatus: 'ACTIVE',
        actorUserId: actor.userId,
        reason: 'Clinic registration approved',
      });
      await this.deps.subscriptions.createForNewClinic(
        tx,
        {
          clinicId,
          planId: input.planId,
          billingCycle: input.billingCycle,
          actorUserId: actor.userId,
        },
        meta,
      );
      await tx.execute(
        `UPDATE clinic_registration_requests SET status = 'APPROVED', decided_at = ?, decided_by_user_id = ?, decision_reason = ?, clinic_id = ? WHERE id = ?`,
        [now, actor.userId, input.reason ?? null, clinicId, id],
      );
      await this.history(tx, id, request.status, 'APPROVED', actor.userId, input.reason ?? null);
      await this.audit(tx, AUDIT_ACTION.REGISTRATION_STATUS_CHANGED, actor.userId, id, meta, {
        from: request.status,
        to: 'APPROVED',
        clinicId,
      });
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.CLINIC_CREATED,
          actorUserId: actor.userId,
          targetType: 'CLINIC',
          targetId: clinicId,
          clinicId,
          metadata: {
            registrationId: id,
            ownerUserId: request.ownerUserId,
            branchId,
            ownerMembershipId: membershipId,
          },
        },
        meta,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MEMBERSHIP_CREATED,
          actorUserId: actor.userId,
          targetType: 'MEMBERSHIP',
          targetId: membershipId,
          clinicId,
          metadata: {
            userId: request.ownerUserId,
            role: 'CLINIC_OWNER',
            via: 'REGISTRATION_APPROVAL',
          },
        },
        meta,
      );
      await this.deps.outbox.record(tx, {
        type: 'clinic.approved',
        aggregateType: 'clinic',
        aggregateId: clinicId,
        clinicId,
        payload: { registrationId: id },
      });
      return { clinicId, branchId, ownerMembershipId: membershipId };
    });
  }

  // ---------- internals ----------

  private async decide(
    actor: Principal,
    id: string,
    to: RegistrationStatus,
    reason: string | null,
    meta: RequestMeta,
    requiredFrom?: RegistrationStatus,
  ) {
    await this.deps.authz.assert(actor, 'platform.registrations.review');
    return this.deps.db.transaction(async (tx) => {
      const request = await this.lockForDecision(tx, actor, id);
      if (requiredFrom !== undefined && request.status !== requiredFrom) {
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          `Registration cannot change from ${request.status} to ${to} here`,
        );
      }
      REGISTRATION_LIFECYCLE.assert(request.status, to);
      if (isApplicantTransition(request.status, to))
        throw new AppError(403, 'FORBIDDEN', 'This transition is performed by the applicant');
      const decisive = to === 'REJECTED' || to === 'NEEDS_INFORMATION' || to === 'SUSPENDED';
      await tx.execute(
        `UPDATE clinic_registration_requests SET status = ?, decided_at = ?, decided_by_user_id = ?, decision_reason = ? WHERE id = ?`,
        [to, this.deps.clock(), actor.userId, decisive ? reason : request.decisionReason, id],
      );
      await this.history(tx, id, request.status, to, actor.userId, reason);
      await this.audit(tx, AUDIT_ACTION.REGISTRATION_STATUS_CHANGED, actor.userId, id, meta, {
        from: request.status,
        to,
        reason,
      });
      await this.deps.outbox.record(tx, {
        type: `registration.${to.toLowerCase()}`,
        aggregateType: 'registration',
        aggregateId: id,
      });
      return this.mustFind(tx, id);
    });
  }

  /** Locks a submitted request for a reviewer; reviewers can never decide their own request. */
  private async lockForDecision(
    tx: SqlExecutor,
    actor: Principal,
    id: string,
  ): Promise<RegistrationRequest> {
    const rows = await tx.query<Row>(
      'SELECT * FROM clinic_registration_requests WHERE id = ? FOR UPDATE',
      [id],
    );
    const request = rows[0] === undefined ? undefined : toRequest(rows[0]);
    if (request === undefined || request.status === 'DRAFT')
      throw new NotFoundError('Registration request not found');
    if (request.ownerUserId === actor.userId) {
      throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', 'You cannot review your own registration');
    }
    return request;
  }

  private async reviewable(executor: SqlExecutor, id: string): Promise<RegistrationRequest> {
    const request = await this.find(executor, id);
    if (request === undefined || request.status === 'DRAFT')
      throw new NotFoundError('Registration request not found');
    return request;
  }

  private assertEditable(request: RegistrationRequest): void {
    if (!EDITABLE_STATUSES.includes(request.status)) {
      throw new AppError(
        409,
        'REGISTRATION_NOT_EDITABLE',
        `A ${request.status} registration cannot be changed`,
      );
    }
  }

  private assertApplicantTransition(from: RegistrationStatus, to: RegistrationStatus): void {
    REGISTRATION_LIFECYCLE.assert(from, to);
    if (!isApplicantTransition(from, to))
      throw new AppError(403, 'FORBIDDEN', 'Only a reviewer can perform this transition');
  }

  private async ownRequest(
    executor: SqlExecutor,
    actor: Principal,
    id: string,
    forUpdate = false,
  ): Promise<RegistrationRequest> {
    const rows = await executor.query<Row>(
      `SELECT * FROM clinic_registration_requests WHERE id = ? AND owner_user_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, actor.userId],
    );
    if (rows[0] === undefined) throw new NotFoundError('Registration request not found');
    return toRequest(rows[0]);
  }

  private async find(executor: SqlExecutor, id: string): Promise<RegistrationRequest | undefined> {
    const rows = await executor.query<Row>(
      'SELECT * FROM clinic_registration_requests WHERE id = ?',
      [id],
    );
    return rows[0] === undefined ? undefined : toRequest(rows[0]);
  }

  private async mustFind(executor: SqlExecutor, id: string): Promise<RegistrationRequest> {
    return must(await this.find(executor, id), 'registration request');
  }

  private async history(
    tx: SqlExecutor,
    id: string,
    from: RegistrationStatus | null,
    to: RegistrationStatus,
    actorUserId: string,
    reason: string | null,
  ): Promise<void> {
    await tx.execute(
      'INSERT INTO clinic_registration_review_history (registration_request_id, from_status, to_status, actor_user_id, reason) VALUES (?, ?, ?, ?, ?)',
      [id, from, to, actorUserId, reason],
    );
  }

  private async listHistory(executor: SqlExecutor, id: string) {
    return executor.query<{
      id: string;
      fromStatus: string | null;
      toStatus: string;
      actorUserId: string;
      reason: string | null;
      createdAt: Date;
    }>(
      `SELECT id, from_status AS fromStatus, to_status AS toStatus, actor_user_id AS actorUserId, reason, created_at AS createdAt
         FROM clinic_registration_review_history WHERE registration_request_id = ? ORDER BY id`,
      [id],
    );
  }

  private async audit(
    tx: SqlExecutor,
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
    actorUserId: string,
    id: string,
    meta: RequestMeta,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.auditLog.record(
      tx,
      { action, actorUserId, targetType: 'REGISTRATION', targetId: id, metadata },
      meta,
    );
  }
}

function toColumns(fields: Partial<RegistrationFields>): Record<string, string | number | null> {
  const columns: Record<string, string | number | null> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const column = REGISTRATION_COLUMNS[field];
    if (column === undefined) throw new Error(`Unmapped field ${field}`);
    columns[column] = value;
  }
  return columns;
}
