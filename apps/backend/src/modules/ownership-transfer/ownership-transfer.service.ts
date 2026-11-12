import { must } from '../../shared/must.js';
import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import { defineStateMachine } from '../../shared/state-machine.js';
import type {
  AuthorizationService,
  MembershipsRepository,
  Principal,
  TenantContext,
} from '../access/index.js';
import { membershipPeriod } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type {
  DocumentMetadata,
  DomainEventOutbox,
  PlatformSettingsService,
  PrivateDocuments,
} from '../platform/index.js';

export const TRANSFER_STATUSES = [
  'PENDING_ACCEPTANCE',
  'PENDING_REVIEW',
  'COMPLETED',
  'REJECTED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_LIFECYCLE = defineStateMachine<TransferStatus>('Ownership transfer', {
  PENDING_ACCEPTANCE: ['PENDING_REVIEW', 'DECLINED', 'CANCELLED', 'EXPIRED'],
  PENDING_REVIEW: ['COMPLETED', 'REJECTED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  DECLINED: [],
  CANCELLED: [],
  EXPIRED: [],
});

/** Document required before a Super Admin may approve. */
export const REQUIRED_TRANSFER_DOCUMENT = 'TRANSFER_AGREEMENT';

interface Row {
  id: string;
  clinic_id: string;
  from_user_id: string;
  to_user_id: string;
  status: TransferStatus;
  reason: string | null;
  from_user_approved_at: Date;
  to_user_accepted_at: Date | null;
  identity_verification: 'PENDING' | 'VERIFIED' | 'FAILED';
  identity_verified_by_user_id: string | null;
  identity_verified_at: Date | null;
  identity_note: string | null;
  expires_at: Date;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  created_at: Date;
}

const toTransfer = (r: Row) => ({
  id: r.id,
  clinicId: r.clinic_id,
  fromUserId: r.from_user_id,
  toUserId: r.to_user_id,
  status: r.status,
  reason: r.reason,
  fromUserApprovedAt: r.from_user_approved_at,
  toUserAcceptedAt: r.to_user_accepted_at,
  identityVerification: r.identity_verification,
  identityVerifiedByUserId: r.identity_verified_by_user_id,
  identityVerifiedAt: r.identity_verified_at,
  identityNote: r.identity_note,
  expiresAt: r.expires_at,
  decidedByUserId: r.decided_by_user_id,
  decidedAt: r.decided_at,
  decisionReason: r.decision_reason,
  createdAt: r.created_at,
});
export type OwnershipTransfer = ReturnType<typeof toTransfer>;

export interface OwnershipTransferDeps {
  readonly db: Database;
  readonly authz: AuthorizationService;
  readonly memberships: MembershipsRepository;
  readonly documents: PrivateDocuments;
  readonly settings: PlatformSettingsService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
  readonly clock: Clock;
}

/**
 * Ownership transfer (see OWNERSHIP_TRANSFER.md):
 *   current owner initiates (= owner's explicit approval) → recipient accepts → Super Admin
 *   verifies identity → Super Admin approves → atomic swap of owner memberships.
 * Only memberships of THIS clinic change. Accounts, credentials, sessions and memberships in
 * other clinics are never touched. The previous owner keeps no role in this clinic unless the
 * new owner later invites them.
 */
export class OwnershipTransferService {
  constructor(private readonly deps: OwnershipTransferDeps) {}

  // ---------- current owner ----------

  async initiate(
    actor: Principal,
    tenant: TenantContext,
    input: { toPhoneE164: string; reason?: string | undefined },
    meta: RequestMeta,
  ): Promise<OwnershipTransfer> {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    if (!tenant.memberships.some((m) => m.role === 'CLINIC_OWNER'))
      throw new AppError(403, 'FORBIDDEN', 'Only a clinic owner can transfer ownership');
    return this.deps.db.transaction(async (tx) => {
      const clinic = await this.lockClinic(tx, tenant.clinicId);
      if (clinic.operational_status !== 'ACTIVE' && clinic.operational_status !== 'SUSPENDED') {
        throw new ConflictError(`A ${clinic.operational_status} clinic cannot be transferred`);
      }
      const recipient = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE phone_e164 = ? AND status = 'ACTIVE' AND phone_verified_at IS NOT NULL`,
        [input.toPhoneE164],
      );
      const toUserId = recipient[0]?.id;
      if (toUserId === undefined)
        throw new AppError(
          422,
          'RECIPIENT_NOT_ELIGIBLE',
          'The new owner must have an active, verified account',
        );
      if (toUserId === actor.userId)
        throw new AppError(
          422,
          'RECIPIENT_NOT_ELIGIBLE',
          'You cannot transfer ownership to yourself',
        );
      await this.expireStale(tx, tenant.clinicId);
      const open = await tx.query(
        `SELECT id FROM clinic_ownership_transfers WHERE clinic_id = ? AND status IN ('PENDING_ACCEPTANCE', 'PENDING_REVIEW')`,
        [tenant.clinicId],
      );
      if (open.length > 0) throw new ConflictError('An ownership transfer is already in progress');
      const now = this.deps.clock();
      const ttlHours = await this.deps.settings.get('ownership_transfer.acceptance_ttl_hours', tx);
      const id = String(
        (
          await tx.execute(
            'INSERT INTO clinic_ownership_transfers (clinic_id, from_user_id, to_user_id, reason, from_user_approved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            [
              tenant.clinicId,
              actor.userId,
              toUserId,
              input.reason ?? null,
              now,
              new Date(now.getTime() + ttlHours * 3_600_000),
            ],
          )
        ).insertId,
      );
      await this.record(
        tx,
        id,
        tenant.clinicId,
        'INITIATED',
        null,
        'PENDING_ACCEPTANCE',
        actor.userId,
        input.reason ?? null,
        meta,
      );
      await this.deps.outbox.record(tx, {
        type: 'ownership_transfer.initiated',
        aggregateType: 'ownership_transfer',
        aggregateId: id,
        clinicId: tenant.clinicId,
        payload: { toUserId },
      });
      return this.mustFind(tx, id);
    });
  }

  async cancel(
    actor: Principal,
    tenant: TenantContext,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    await this.deps.db.transaction(async (tx) => {
      const t = await this.lock(tx, id, tenant.clinicId);
      TRANSFER_LIFECYCLE.assert(t.status, 'CANCELLED');
      await tx.execute(`UPDATE clinic_ownership_transfers SET status = 'CANCELLED' WHERE id = ?`, [
        id,
      ]);
      await this.record(
        tx,
        id,
        t.clinicId,
        'CANCELLED',
        t.status,
        'CANCELLED',
        actor.userId,
        null,
        meta,
      );
    });
  }

  async listForClinic(actor: Principal, tenant: TenantContext): Promise<OwnershipTransfer[]> {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    const rows = await this.deps.db.query<Row>(
      'SELECT * FROM clinic_ownership_transfers WHERE clinic_id = ? ORDER BY id DESC',
      [tenant.clinicId],
    );
    return rows.map(toTransfer);
  }

  // ---------- recipient ----------

  async incoming(actor: Principal): Promise<OwnershipTransfer[]> {
    const rows = await this.deps.db.query<Row>(
      `SELECT * FROM clinic_ownership_transfers WHERE to_user_id = ? AND status IN ('PENDING_ACCEPTANCE', 'PENDING_REVIEW') ORDER BY id DESC`,
      [actor.userId],
    );
    return rows.map(toTransfer);
  }

  async accept(actor: Principal, id: string, meta: RequestMeta): Promise<OwnershipTransfer> {
    return this.respond(actor, id, 'PENDING_REVIEW', meta);
  }

  async decline(actor: Principal, id: string, meta: RequestMeta): Promise<OwnershipTransfer> {
    return this.respond(actor, id, 'DECLINED', meta);
  }

  // ---------- documents (parties and reviewers) ----------

  async uploadDocument(
    actor: Principal,
    id: string,
    input: Parameters<PrivateDocuments['upload']>[3],
    meta: RequestMeta,
  ): Promise<DocumentMetadata> {
    return this.deps.db.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      this.assertParty(actor, t);
      if (t.status !== 'PENDING_ACCEPTANCE' && t.status !== 'PENDING_REVIEW')
        throw new ConflictError('Documents can only be added while the transfer is open');
      const doc = await this.deps.documents.upload(tx, id, actor.userId, input);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.DOCUMENT_UPLOADED,
          actorUserId: actor.userId,
          targetType: 'DOCUMENT',
          targetId: doc.id,
          clinicId: t.clinicId,
          metadata: { parent: 'OWNERSHIP_TRANSFER', parentId: id, type: doc.documentType },
        },
        meta,
      );
      return doc;
    });
  }

  async getAsParty(actor: Principal, id: string) {
    const t = await this.find(this.deps.db, id);
    if (t === undefined) throw new NotFoundError('Ownership transfer not found');
    this.assertParty(actor, t);
    return { transfer: t, documents: await this.deps.documents.list(this.deps.db, id) };
  }

  async readDocumentAsParty(actor: Principal, id: string, documentId: string) {
    const t = await this.find(this.deps.db, id);
    if (t === undefined) throw new NotFoundError('Ownership transfer not found');
    this.assertParty(actor, t);
    return this.deps.documents.read(this.deps.db, id, documentId);
  }

  // ---------- Super Admin ----------

  async list(
    actor: Principal,
    filter: { status?: TransferStatus | undefined; limit: number; cursor?: string | undefined },
  ) {
    await this.deps.authz.assert(actor, 'platform.ownership.review');
    const rows = await this.deps.db.query<Row>(
      'SELECT * FROM clinic_ownership_transfers WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',
      [
        filter.status ?? null,
        filter.status ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return toPage(rows.map(toTransfer), filter.limit);
  }

  async getForReview(actor: Principal, id: string) {
    await this.deps.authz.assert(actor, 'platform.ownership.review');
    const transfer = await this.find(this.deps.db, id);
    if (transfer === undefined) throw new NotFoundError('Ownership transfer not found');
    const history = await this.deps.db.query(
      'SELECT id, event, from_status AS fromStatus, to_status AS toStatus, actor_user_id AS actorUserId, note, created_at AS createdAt FROM clinic_ownership_transfer_history WHERE transfer_id = ? ORDER BY id',
      [id],
    );
    return { transfer, documents: await this.deps.documents.list(this.deps.db, id, true), history };
  }

  async readDocumentForReview(actor: Principal, id: string, documentId: string, meta: RequestMeta) {
    await this.deps.authz.assert(actor, 'platform.ownership.review');
    const doc = await this.deps.documents.read(this.deps.db, id, documentId);
    await this.deps.auditLog.record(
      this.deps.db,
      {
        action: AUDIT_ACTION.DOCUMENT_ACCESSED,
        actorUserId: actor.userId,
        targetType: 'DOCUMENT',
        targetId: documentId,
        metadata: { parent: 'OWNERSHIP_TRANSFER', parentId: id },
      },
      meta,
    );
    return doc;
  }

  async recordIdentityVerification(
    actor: Principal,
    id: string,
    result: 'VERIFIED' | 'FAILED',
    note: string,
    meta: RequestMeta,
  ): Promise<OwnershipTransfer> {
    await this.deps.authz.assert(actor, 'platform.ownership.review');
    return this.deps.db.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      this.assertNotParty(actor, t);
      if (t.status !== 'PENDING_REVIEW')
        throw new ConflictError('Identity can be verified only after the recipient accepted');
      await tx.execute(
        'UPDATE clinic_ownership_transfers SET identity_verification = ?, identity_verified_by_user_id = ?, identity_verified_at = ?, identity_note = ? WHERE id = ?',
        [result, actor.userId, this.deps.clock(), note, id],
      );
      await this.record(
        tx,
        id,
        t.clinicId,
        `IDENTITY_${result}`,
        t.status,
        t.status,
        actor.userId,
        note,
        meta,
      );
      return this.mustFind(tx, id);
    });
  }

  async reject(actor: Principal, id: string, reason: string, meta: RequestMeta): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.ownership.review');
    await this.deps.db.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      this.assertNotParty(actor, t);
      TRANSFER_LIFECYCLE.assert(t.status, 'REJECTED');
      await tx.execute(
        `UPDATE clinic_ownership_transfers SET status = 'REJECTED', decided_by_user_id = ?, decided_at = ?, decision_reason = ? WHERE id = ?`,
        [actor.userId, this.deps.clock(), reason, id],
      );
      await this.record(
        tx,
        id,
        t.clinicId,
        'REJECTED',
        t.status,
        'REJECTED',
        actor.userId,
        reason,
        meta,
      );
    });
  }

  /** Final approval: the atomic ownership swap. Concurrent approvals serialize on row locks. */
  async approve(
    actor: Principal,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<OwnershipTransfer> {
    await this.deps.authz.assert(actor, 'platform.ownership.review');
    return this.deps.db.transaction(async (tx) => {
      const pre = await this.find(tx, id);
      if (pre === undefined) throw new NotFoundError('Ownership transfer not found');
      const clinic = await this.lockClinic(tx, pre.clinicId); // same lock order as membership changes: clinic first
      const t = await this.lock(tx, id);
      this.assertNotParty(actor, t);
      TRANSFER_LIFECYCLE.assert(t.status, 'COMPLETED');
      if (t.identityVerification !== 'VERIFIED')
        throw new AppError(
          409,
          'IDENTITY_NOT_VERIFIED',
          'The recipient identity has not been verified',
        );
      const docs = await this.deps.documents.list(tx, id);
      if (!docs.some((d) => d.documentType === REQUIRED_TRANSFER_DOCUMENT)) {
        throw new AppError(
          409,
          'DOCUMENTS_MISSING',
          `A ${REQUIRED_TRANSFER_DOCUMENT} document is required`,
        );
      }
      if (clinic.operational_status !== 'ACTIVE' && clinic.operational_status !== 'SUSPENDED')
        throw new ConflictError(`A ${clinic.operational_status} clinic cannot be transferred`);
      const recipient = await tx.query(
        `SELECT id FROM users WHERE id = ? AND status = 'ACTIVE' AND phone_verified_at IS NOT NULL FOR UPDATE`,
        [t.toUserId],
      );
      if (recipient.length === 0)
        throw new AppError(
          409,
          'RECIPIENT_NOT_ELIGIBLE',
          'The recipient account is no longer active and verified',
        );

      const now = this.deps.clock();
      const previous = await this.deps.memberships.listForUserInClinic(
        tx,
        t.clinicId,
        t.fromUserId,
        true,
      );
      if (!previous.some((m) => m.role === 'CLINIC_OWNER' && m.status === 'ACTIVE')) {
        throw new AppError(
          409,
          'INITIATOR_NO_LONGER_OWNER',
          'The initiating user is no longer an active owner',
        );
      }
      // 1. The previous owner leaves this clinic entirely (all roles here).
      for (const m of previous.filter((x) => x.status !== 'TERMINATED')) {
        await this.deps.memberships.updateStatus(tx, t.clinicId, m.id, 'TERMINATED', now);
        await this.deps.memberships.insertEvent(tx, {
          membershipId: m.id,
          clinicId: t.clinicId,
          fromStatus: m.status,
          toStatus: 'TERMINATED',
          actorUserId: actor.userId,
          reason: `Ownership transferred (transfer ${id})`,
        });
        await this.deps.auditLog.record(
          tx,
          {
            action: AUDIT_ACTION.MEMBERSHIP_STATUS_CHANGED,
            actorUserId: actor.userId,
            targetType: 'MEMBERSHIP',
            targetId: m.id,
            clinicId: t.clinicId,
            metadata: {
              from: m.status,
              to: 'TERMINATED',
              reason: 'OWNERSHIP_TRANSFERRED',
              transferId: id,
            },
          },
          meta,
        );
      }
      await this.deps.memberships.clearActiveClinicIfNoAccess(tx, t.fromUserId, t.clinicId, now);
      // 2. The new owner gets (or regains) CLINIC_OWNER for all branches.
      const recipientRows = await this.deps.memberships.listForUserInClinic(
        tx,
        t.clinicId,
        t.toUserId,
        true,
      );
      const existingOwner = recipientRows.find((m) => m.role === 'CLINIC_OWNER');
      let ownerMembershipId: string;
      if (existingOwner === undefined) {
        ownerMembershipId = await this.deps.memberships.insert(tx, {
          clinicId: t.clinicId,
          userId: t.toUserId,
          role: 'CLINIC_OWNER',
          branchScope: 'ALL',
          effectiveFrom: null,
          effectiveUntil: null,
          createdBy: actor.userId,
          now,
        });
      } else {
        // New ownership period on the recipient's old owner row (stale dates never carry over).
        ownerMembershipId = existingOwner.id;
        await this.deps.memberships.reactivateAsNewPeriod(
          tx,
          t.clinicId,
          existingOwner.id,
          { effectiveFrom: null, effectiveUntil: null },
          now,
        );
        await this.deps.memberships.replaceBranches(tx, t.clinicId, existingOwner.id, 'ALL', []);
      }
      await this.deps.memberships.insertEvent(tx, {
        membershipId: ownerMembershipId,
        clinicId: t.clinicId,
        fromStatus: existingOwner?.status ?? null,
        toStatus: 'ACTIVE',
        actorUserId: actor.userId,
        reason: `Ownership transferred (transfer ${id})`,
      });
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.MEMBERSHIP_CREATED,
          actorUserId: actor.userId,
          targetType: 'MEMBERSHIP',
          targetId: ownerMembershipId,
          clinicId: t.clinicId,
          metadata: {
            userId: t.toUserId,
            role: 'CLINIC_OWNER',
            via: 'OWNERSHIP_TRANSFER',
            transferId: id,
            ...(existingOwner === undefined
              ? {}
              : { reactivated: true, previousPeriod: membershipPeriod(existingOwner) }),
          },
        },
        meta,
      );
      // 3. Close the transfer.
      await tx.execute(
        `UPDATE clinic_ownership_transfers SET status = 'COMPLETED', decided_by_user_id = ?, decided_at = ?, decision_reason = ? WHERE id = ?`,
        [actor.userId, now, reason, id],
      );
      await this.record(
        tx,
        id,
        t.clinicId,
        'COMPLETED',
        t.status,
        'COMPLETED',
        actor.userId,
        reason,
        meta,
      );
      await this.deps.outbox.record(tx, {
        type: 'ownership_transfer.completed',
        aggregateType: 'ownership_transfer',
        aggregateId: id,
        clinicId: t.clinicId,
        payload: { fromUserId: t.fromUserId, toUserId: t.toUserId },
      });
      return this.mustFind(tx, id);
    });
  }

  /** Closing hook: an open transfer cannot continue once a clinic starts closing. */
  async cancelOpenForClinic(
    tx: SqlExecutor,
    clinicId: string,
    actorUserId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const open = await tx.query<Row>(
      `SELECT * FROM clinic_ownership_transfers WHERE clinic_id = ? AND status IN ('PENDING_ACCEPTANCE', 'PENDING_REVIEW') FOR UPDATE`,
      [clinicId],
    );
    for (const row of open) {
      await tx.execute(`UPDATE clinic_ownership_transfers SET status = 'CANCELLED' WHERE id = ?`, [
        row.id,
      ]);
      await this.record(
        tx,
        row.id,
        clinicId,
        'CANCELLED_BY_CLOSURE',
        row.status,
        'CANCELLED',
        actorUserId,
        'Clinic closing',
        meta,
      );
    }
  }

  // ---------- internals ----------

  private async respond(
    actor: Principal,
    id: string,
    to: 'PENDING_REVIEW' | 'DECLINED',
    meta: RequestMeta,
  ): Promise<OwnershipTransfer> {
    const result = await this.deps.db.transaction(async (tx) => {
      const t = await this.lock(tx, id);
      if (t.toUserId !== actor.userId) throw new NotFoundError('Ownership transfer not found');
      if (t.status === 'PENDING_ACCEPTANCE' && t.expiresAt <= this.deps.clock()) {
        await tx.execute(`UPDATE clinic_ownership_transfers SET status = 'EXPIRED' WHERE id = ?`, [
          id,
        ]);
        await this.record(tx, id, t.clinicId, 'EXPIRED', t.status, 'EXPIRED', null, null, meta);
        return { expired: true as const };
      }
      TRANSFER_LIFECYCLE.assert(t.status, to);
      await tx.execute(
        `UPDATE clinic_ownership_transfers SET status = ?, to_user_accepted_at = ? WHERE id = ?`,
        [to, to === 'PENDING_REVIEW' ? this.deps.clock() : null, id],
      );
      await this.record(
        tx,
        id,
        t.clinicId,
        to === 'PENDING_REVIEW' ? 'ACCEPTED' : 'DECLINED',
        t.status,
        to,
        actor.userId,
        null,
        meta,
      );
      return { expired: false as const, transfer: await this.mustFind(tx, id) };
    });
    if (result.expired)
      throw new AppError(410, 'TRANSFER_EXPIRED', 'This ownership transfer has expired');
    return result.transfer;
  }

  private async expireStale(tx: SqlExecutor, clinicId: string): Promise<void> {
    await tx.execute(
      `UPDATE clinic_ownership_transfers SET status = 'EXPIRED' WHERE clinic_id = ? AND status = 'PENDING_ACCEPTANCE' AND expires_at <= ?`,
      [clinicId, this.deps.clock()],
    );
  }

  private assertParty(actor: Principal, t: OwnershipTransfer): void {
    if (actor.userId !== t.fromUserId && actor.userId !== t.toUserId)
      throw new NotFoundError('Ownership transfer not found');
  }

  private assertNotParty(actor: Principal, t: OwnershipTransfer): void {
    if (actor.userId === t.fromUserId || actor.userId === t.toUserId)
      throw new AppError(
        403,
        'SELF_APPROVAL_FORBIDDEN',
        'Parties cannot review their own transfer',
      );
  }

  private async lockClinic(
    tx: SqlExecutor,
    clinicId: string,
  ): Promise<{ id: string; operational_status: string }> {
    const rows = await tx.query<{ id: string; operational_status: string }>(
      'SELECT id, operational_status FROM clinics WHERE id = ? FOR UPDATE',
      [clinicId],
    );
    if (rows[0] === undefined) throw new NotFoundError('Clinic not found');
    return rows[0];
  }

  private async find(executor: SqlExecutor, id: string): Promise<OwnershipTransfer | undefined> {
    const rows = await executor.query<Row>(
      'SELECT * FROM clinic_ownership_transfers WHERE id = ?',
      [id],
    );
    return rows[0] === undefined ? undefined : toTransfer(rows[0]);
  }

  private async mustFind(executor: SqlExecutor, id: string): Promise<OwnershipTransfer> {
    return must(await this.find(executor, id), 'ownership transfer');
  }

  private async lock(tx: SqlExecutor, id: string, clinicId?: string): Promise<OwnershipTransfer> {
    const rows = await tx.query<Row>(
      'SELECT * FROM clinic_ownership_transfers WHERE id = ? AND (? IS NULL OR clinic_id = ?) FOR UPDATE',
      [id, clinicId ?? null, clinicId ?? null],
    );
    if (rows[0] === undefined) throw new NotFoundError('Ownership transfer not found');
    return toTransfer(rows[0]);
  }

  private async record(
    tx: SqlExecutor,
    id: string,
    clinicId: string,
    event: string,
    from: TransferStatus | null,
    to: TransferStatus,
    actorUserId: string | null,
    note: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    await tx.execute(
      'INSERT INTO clinic_ownership_transfer_history (transfer_id, event, from_status, to_status, actor_user_id, note) VALUES (?, ?, ?, ?, ?, ?)',
      [id, event, from, to, actorUserId, note],
    );
    await this.deps.auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.OWNERSHIP_TRANSFER_CHANGED,
        actorUserId,
        targetType: 'OWNERSHIP_TRANSFER',
        targetId: id,
        clinicId,
        metadata: { event, from, to, note },
      },
      meta,
    );
  }
}
