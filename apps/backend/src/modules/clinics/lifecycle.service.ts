import { must, toIsoDate } from '../../shared/must.js';
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
import type { AuthorizationService, Principal, TenantContext } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { DomainEventOutbox, PlatformSettingsService } from '../platform/index.js';
import type { Clinic, ClinicsRepository } from './clinics.repository.js';
import {
  CLINIC_LIFECYCLE,
  type OperationalStatus,
  type SuspensionScope,
} from './operation-policy.js';

export const CLOSURE_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'COMPLETED',
] as const;
export type ClosureStatus = (typeof CLOSURE_STATUSES)[number];

export const CLOSURE_LIFECYCLE = defineStateMachine<ClosureStatus>('Closure request', {
  PENDING_REVIEW: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['COMPLETED'],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
});

/**
 * Required actions created when a closure is approved. Until the bookings/queue/payments modules
 * exist they are confirmed manually (owner resolves with a note; Super Admin may waive). Future
 * modules register ClosureActionProviders that add automatically detected actions.
 */
export const DEFAULT_CLOSURE_ACTIONS: readonly { type: string; details: string }[] = [
  {
    type: 'ACTIVE_BOOKINGS',
    details: 'Review, complete or cancel all future bookings and inform affected patients',
  },
  { type: 'OPEN_QUEUE_AND_CASES', details: 'Resolve the queue and hand over open patient cases' },
  {
    type: 'PATIENT_NOTIFICATION',
    details: 'Notify patients of the closure and how to obtain their records',
  },
  {
    type: 'MEDICAL_RECORDS_RETENTION',
    details: 'Confirm medical records are retained per legal retention requirements',
  },
  { type: 'FINANCIAL_RECORDS', details: 'Confirm financial records are settled and retained' },
  {
    type: 'MEMBERSHIPS_AND_ADMIN_TASKS',
    details: 'Handle staff memberships and outstanding administrative tasks',
  },
];

export interface ClosureActionProvider {
  detect(tx: SqlExecutor, clinicId: string): Promise<{ type: string; details: string }[]>;
}

/** Side effects other modules perform when a clinic starts closing (e.g. revoke invitations). */
export type ClosingHook = (
  tx: SqlExecutor,
  clinicId: string,
  actorUserId: string,
  meta: RequestMeta,
) => Promise<void>;
/** Side effects when the clinic is finally closed (e.g. end the subscription). */
export type ClosedHook = ClosingHook;

interface ClosureRow {
  id: string;
  clinic_id: string;
  status: ClosureStatus;
  reason: string;
  requested_effective_date: Date | string | null;
  requested_by_user_id: string;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  completed_by_user_id: string | null;
  completed_at: Date | null;
  created_at: Date;
}

const toClosure = (r: ClosureRow) => ({
  id: r.id,
  clinicId: r.clinic_id,
  status: r.status,
  reason: r.reason,
  requestedEffectiveDate: toIsoDate(r.requested_effective_date),
  requestedByUserId: r.requested_by_user_id,
  decidedByUserId: r.decided_by_user_id,
  decidedAt: r.decided_at,
  decisionReason: r.decision_reason,
  completedByUserId: r.completed_by_user_id,
  completedAt: r.completed_at,
  createdAt: r.created_at,
});

export type ClosureRequest = ReturnType<typeof toClosure>;

export interface LifecycleDeps {
  readonly db: Database;
  readonly clinics: ClinicsRepository;
  readonly authz: AuthorizationService;
  readonly settings: PlatformSettingsService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
  readonly clock: Clock;
  readonly closureProviders?: readonly ClosureActionProvider[];
  readonly onClosing?: readonly ClosingHook[];
  readonly onClosed?: readonly ClosedHook[];
}

/**
 * Operational lifecycle: suspension / reinstatement, continuity-of-care access exceptions,
 * and controlled closure. Every change: clinic row lock, state machine, lifecycle history,
 * audit event and outbox event in ONE transaction. Nothing is deleted.
 */
export class ClinicLifecycleService {
  constructor(private readonly deps: LifecycleDeps) {}

  // ---------- Suspension (Super Admin) ----------

  async suspend(
    actor: Principal,
    clinicId: string,
    input: { scope: SuspensionScope; reason: string; expectedEndAt?: string | undefined },
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    const now = this.deps.clock();
    const expectedEndAt = input.expectedEndAt === undefined ? null : new Date(input.expectedEndAt);
    if (expectedEndAt !== null && expectedEndAt <= now) {
      throw new ValidationError([
        { location: 'body', path: 'expectedEndAt', message: 'must be in the future' },
      ]);
    }
    await this.deps.db.transaction(async (tx) => {
      const clinic = await this.lockClinic(tx, clinicId);
      CLINIC_LIFECYCLE.assert(clinic.operationalStatus, 'SUSPENDED');
      const result = await tx.execute(
        'INSERT INTO clinic_suspensions (clinic_id, scope, reason, starts_at, expected_end_at, suspended_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
        [clinicId, input.scope, input.reason, now, expectedEndAt, actor.userId],
      );
      const suspensionId = String(result.insertId);
      await this.changeStatus(tx, clinic, 'SUSPENDED', actor.userId, input.reason, meta, {
        type: 'SUSPENSION',
        id: suspensionId,
        scope: input.scope,
      });
    });
  }

  /** Formal reinstatement: ends the open suspension; SUSPENDED → ACTIVE (CLOSING stays CLOSING). */
  async reinstate(
    actor: Principal,
    clinicId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    await this.deps.db.transaction(async (tx) => {
      const clinic = await this.lockClinic(tx, clinicId);
      const suspension = await this.deps.clinics.openSuspension(tx, clinicId, true);
      if (suspension === undefined) throw new ConflictError('The clinic is not suspended');
      await tx.execute(
        'UPDATE clinic_suspensions SET ended_at = ?, ended_by_user_id = ?, end_reason = ? WHERE id = ?',
        [this.deps.clock(), actor.userId, reason, suspension.id],
      );
      if (clinic.operationalStatus === 'SUSPENDED') {
        await this.changeStatus(tx, clinic, 'ACTIVE', actor.userId, reason, meta, {
          type: 'SUSPENSION',
          id: suspension.id,
        });
      } else {
        await this.deps.auditLog.record(
          tx,
          {
            action: AUDIT_ACTION.CLINIC_STATUS_CHANGED,
            actorUserId: actor.userId,
            targetType: 'CLINIC',
            targetId: clinicId,
            clinicId,
            metadata: { suspensionEnded: suspension.id, reason, status: clinic.operationalStatus },
          },
          meta,
        );
      }
    });
  }

  async suspensions(actor: Principal, clinicId: string) {
    await this.deps.authz.assert(actor, 'platform.clinics.view');
    return this.deps.clinics.listSuspensions(this.deps.db, clinicId);
  }

  // ---------- Continuity-of-care access exceptions (Super Admin) ----------

  async grantAccessException(
    actor: Principal,
    clinicId: string,
    input: { userId: string; reason: string; expiresAt: string },
    meta: RequestMeta,
  ): Promise<string> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    // Separation of duties, as for every other platform approval: a Super Admin who is also a
    // member of the suspended clinic cannot lift the suspension for themselves.
    if (input.userId === actor.userId)
      throw new AppError(
        403,
        'SELF_APPROVAL_FORBIDDEN',
        'You cannot grant yourself an access exception',
      );
    const now = this.deps.clock();
    const expiresAt = new Date(input.expiresAt);
    const maxHours = await this.deps.settings.get('access_exception.max_duration_hours');
    if (expiresAt <= now || expiresAt.getTime() - now.getTime() > maxHours * 3_600_000) {
      throw new ValidationError([
        {
          location: 'body',
          path: 'expiresAt',
          message: `must be in the future and within ${maxHours} hours`,
        },
      ]);
    }
    return this.deps.db.transaction(async (tx) => {
      await this.lockClinic(tx, clinicId);
      const suspension = await this.deps.clinics.openSuspension(tx, clinicId, true);
      if (suspension?.scope !== 'FULL')
        throw new ConflictError('Access exceptions only apply to a FULL suspension');
      const member = await tx.query(
        `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND user_id = ? AND status = 'ACTIVE' LIMIT 1`,
        [clinicId, input.userId],
      );
      // An exception never creates access: it only lifts the suspension for an existing member.
      if (member.length === 0)
        throw new ConflictError('The user has no active membership in this clinic');
      const id = String(
        (
          await tx.execute(
            'INSERT INTO clinic_access_exceptions (clinic_id, suspension_id, user_id, reason, granted_by_user_id, starts_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [clinicId, suspension.id, input.userId, input.reason, actor.userId, now, expiresAt],
          )
        ).insertId,
      );
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.ACCESS_EXCEPTION_GRANTED,
          actorUserId: actor.userId,
          targetType: 'ACCESS_EXCEPTION',
          targetId: id,
          clinicId,
          metadata: {
            userId: input.userId,
            reason: input.reason,
            expiresAt,
            suspensionId: suspension.id,
          },
        },
        meta,
      );
      return id;
    });
  }

  async revokeAccessException(
    actor: Principal,
    clinicId: string,
    exceptionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    await this.deps.db.transaction(async (tx) => {
      const result = await tx.execute(
        'UPDATE clinic_access_exceptions SET revoked_at = ?, revoked_by_user_id = ? WHERE id = ? AND clinic_id = ? AND revoked_at IS NULL',
        [this.deps.clock(), actor.userId, exceptionId, clinicId],
      );
      if (result.affectedRows !== 1) throw new NotFoundError('Access exception not found');
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.ACCESS_EXCEPTION_REVOKED,
          actorUserId: actor.userId,
          targetType: 'ACCESS_EXCEPTION',
          targetId: exceptionId,
          clinicId,
        },
        meta,
      );
    });
  }

  async accessExceptions(actor: Principal, clinicId: string) {
    await this.deps.authz.assert(actor, 'platform.clinics.view');
    return this.deps.db.query(
      `SELECT id, suspension_id AS suspensionId, user_id AS userId, reason, granted_by_user_id AS grantedByUserId,
              starts_at AS startsAt, expires_at AS expiresAt, revoked_at AS revokedAt
         FROM clinic_access_exceptions WHERE clinic_id = ? ORDER BY id DESC`,
      [clinicId],
    );
  }

  // ---------- Closure ----------

  /** Owner requests closure (clinic.lifecycle.manage in the verified clinic context). */
  async requestClosure(
    actor: Principal,
    tenant: TenantContext,
    input: { reason: string; requestedEffectiveDate?: string | undefined },
    meta: RequestMeta,
  ): Promise<ClosureRequest> {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      const clinic = await this.lockClinic(tx, tenant.clinicId);
      if (!CLINIC_LIFECYCLE.can(clinic.operationalStatus, 'CLOSING')) {
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          `A ${clinic.operationalStatus} clinic cannot request closure`,
        );
      }
      const open = await tx.query(
        `SELECT id FROM clinic_closure_requests WHERE clinic_id = ? AND status IN ('PENDING_REVIEW', 'APPROVED')`,
        [tenant.clinicId],
      );
      if (open.length > 0) throw new ConflictError('A closure request is already open');
      const id = String(
        (
          await tx.execute(
            'INSERT INTO clinic_closure_requests (clinic_id, reason, requested_effective_date, requested_by_user_id) VALUES (?, ?, ?, ?)',
            [tenant.clinicId, input.reason, input.requestedEffectiveDate ?? null, actor.userId],
          )
        ).insertId,
      );
      await this.auditClosure(
        tx,
        id,
        tenant.clinicId,
        actor.userId,
        null,
        'PENDING_REVIEW',
        input.reason,
        meta,
      );
      await this.deps.outbox.record(tx, {
        type: 'clinic.closure_requested',
        aggregateType: 'clinic',
        aggregateId: tenant.clinicId,
        clinicId: tenant.clinicId,
        payload: { closureRequestId: id },
      });
      return must(await this.findClosure(tx, id), 'closure request');
    });
  }

  async cancelClosure(
    actor: Principal,
    tenant: TenantContext,
    requestId: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    await this.deps.db.transaction(async (tx) => {
      const request = await this.lockClosure(tx, requestId, tenant.clinicId);
      CLOSURE_LIFECYCLE.assert(request.status, 'CANCELLED');
      await tx.execute(`UPDATE clinic_closure_requests SET status = 'CANCELLED' WHERE id = ?`, [
        requestId,
      ]);
      await this.auditClosure(
        tx,
        requestId,
        tenant.clinicId,
        actor.userId,
        request.status,
        'CANCELLED',
        null,
        meta,
      );
    });
  }

  async listClosuresForClinic(actor: Principal, tenant: TenantContext) {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    const rows = await this.deps.db.query<ClosureRow>(
      'SELECT * FROM clinic_closure_requests WHERE clinic_id = ? ORDER BY id DESC',
      [tenant.clinicId],
    );
    return rows.map(toClosure);
  }

  async closureForClinic(actor: Principal, tenant: TenantContext, requestId: string) {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    const request = await this.findClosure(this.deps.db, requestId, tenant.clinicId);
    if (request === undefined) throw new NotFoundError('Closure request not found');
    return { request, actions: await this.actions(this.deps.db, requestId) };
  }

  async listClosuresForPlatform(
    actor: Principal,
    filter: { status?: ClosureStatus | undefined; limit: number; cursor?: string | undefined },
  ) {
    await this.deps.authz.assert(actor, 'platform.clinics.view');
    const rows = await this.deps.db.query<ClosureRow>(
      'SELECT * FROM clinic_closure_requests WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',
      [
        filter.status ?? null,
        filter.status ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return toPage(rows.map(toClosure), filter.limit);
  }

  async closureForPlatform(actor: Principal, requestId: string) {
    await this.deps.authz.assert(actor, 'platform.clinics.view');
    const request = await this.findClosure(this.deps.db, requestId);
    if (request === undefined) throw new NotFoundError('Closure request not found');
    return { request, actions: await this.actions(this.deps.db, requestId) };
  }

  /** Approval: clinic → CLOSING, required actions created, new operations stop, marketplace removal. */
  async approveClosure(
    actor: Principal,
    requestId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    await this.deps.db.transaction(async (tx) => {
      const request = await this.lockClosure(tx, requestId);
      const clinic = await this.lockClinic(tx, request.clinicId);
      if (request.requestedByUserId === actor.userId)
        throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', 'You cannot approve your own request');
      CLOSURE_LIFECYCLE.assert(request.status, 'APPROVED');
      await tx.execute(
        `UPDATE clinic_closure_requests SET status = 'APPROVED', decided_by_user_id = ?, decided_at = ?, decision_reason = ? WHERE id = ?`,
        [actor.userId, this.deps.clock(), reason, requestId],
      );
      const detected = (
        await Promise.all((this.deps.closureProviders ?? []).map((p) => p.detect(tx, clinic.id)))
      ).flat();
      const actions = new Map<string, string>();
      for (const a of [...DEFAULT_CLOSURE_ACTIONS, ...detected]) actions.set(a.type, a.details);
      for (const [type, details] of actions) {
        await tx.execute(
          'INSERT INTO clinic_closure_actions (closure_request_id, clinic_id, action_type, details) VALUES (?, ?, ?, ?)',
          [requestId, clinic.id, type, details],
        );
      }
      await this.auditClosure(
        tx,
        requestId,
        clinic.id,
        actor.userId,
        request.status,
        'APPROVED',
        reason,
        meta,
      );
      await this.changeStatus(tx, clinic, 'CLOSING', actor.userId, reason, meta, {
        type: 'CLOSURE',
        id: requestId,
      });
      for (const hook of this.deps.onClosing ?? []) await hook(tx, clinic.id, actor.userId, meta);
    });
  }

  async rejectClosure(
    actor: Principal,
    requestId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    await this.deps.db.transaction(async (tx) => {
      const request = await this.lockClosure(tx, requestId);
      CLOSURE_LIFECYCLE.assert(request.status, 'REJECTED');
      await tx.execute(
        `UPDATE clinic_closure_requests SET status = 'REJECTED', decided_by_user_id = ?, decided_at = ?, decision_reason = ? WHERE id = ?`,
        [actor.userId, this.deps.clock(), reason, requestId],
      );
      await this.auditClosure(
        tx,
        requestId,
        request.clinicId,
        actor.userId,
        request.status,
        'REJECTED',
        reason,
        meta,
      );
    });
  }

  /** Owner confirms a required action is done. */
  async resolveActionAsClinic(
    actor: Principal,
    tenant: TenantContext,
    requestId: string,
    actionId: string,
    note: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'clinic.lifecycle.manage', { tenant });
    await this.setAction(actor, requestId, actionId, 'RESOLVED', note, meta, tenant.clinicId);
  }

  /** Super Admin resolves or waives (with justification) a required action. */
  async decideActionAsPlatform(
    actor: Principal,
    requestId: string,
    actionId: string,
    status: 'RESOLVED' | 'WAIVED',
    note: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    await this.setAction(actor, requestId, actionId, status, note, meta);
  }

  /** Completion: all actions resolved/waived → clinic CLOSED; data is retained. */
  async completeClosure(
    actor: Principal,
    requestId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.clinics.manage');
    await this.deps.db.transaction(async (tx) => {
      const request = await this.lockClosure(tx, requestId);
      const clinic = await this.lockClinic(tx, request.clinicId);
      CLOSURE_LIFECYCLE.assert(request.status, 'COMPLETED');
      const open = (await this.actions(tx, requestId)).filter((a) => a.status === 'OPEN');
      if (open.length > 0) {
        throw new AppError(409, 'CLOSURE_BLOCKED', 'Required closure actions are still open', {
          details: { openActions: open.map((a) => a.actionType) },
        });
      }
      const now = this.deps.clock();
      await tx.execute(
        `UPDATE clinic_closure_requests SET status = 'COMPLETED', completed_by_user_id = ?, completed_at = ? WHERE id = ?`,
        [actor.userId, now, requestId],
      );
      await tx.execute(
        'UPDATE clinic_suspensions SET ended_at = ?, ended_by_user_id = ?, end_reason = ? WHERE clinic_id = ? AND ended_at IS NULL',
        [now, actor.userId, 'Clinic closed', clinic.id],
      );
      await this.auditClosure(
        tx,
        requestId,
        clinic.id,
        actor.userId,
        request.status,
        'COMPLETED',
        reason,
        meta,
      );
      await this.changeStatus(tx, clinic, 'CLOSED', actor.userId, reason, meta, {
        type: 'CLOSURE',
        id: requestId,
      });
      for (const hook of this.deps.onClosed ?? []) await hook(tx, clinic.id, actor.userId, meta);
    });
  }

  async history(actor: Principal, clinicId: string) {
    await this.deps.authz.assert(actor, 'platform.clinics.view');
    return this.deps.clinics.listHistory(this.deps.db, clinicId);
  }

  // ---------- internals ----------

  private async setAction(
    actor: Principal,
    requestId: string,
    actionId: string,
    status: 'RESOLVED' | 'WAIVED',
    note: string,
    meta: RequestMeta,
    clinicId?: string,
  ): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const request = await this.lockClosure(tx, requestId, clinicId);
      if (request.status !== 'APPROVED')
        throw new ConflictError('Actions can only be updated while the closure is in progress');
      const result = await tx.execute(
        `UPDATE clinic_closure_actions SET status = ?, resolution_note = ?, resolved_by_user_id = ?, resolved_at = ?
          WHERE id = ? AND closure_request_id = ? AND clinic_id = ? AND status = 'OPEN'`,
        [status, note, actor.userId, this.deps.clock(), actionId, requestId, request.clinicId],
      );
      if (result.affectedRows !== 1) throw new NotFoundError('Open action not found');
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.CLOSURE_ACTION_CHANGED,
          actorUserId: actor.userId,
          targetType: 'CLOSURE_ACTION',
          targetId: actionId,
          clinicId: request.clinicId,
          metadata: { status, note },
        },
        meta,
      );
    });
  }

  private async actions(executor: SqlExecutor, requestId: string) {
    return executor.query<{
      id: string;
      actionType: string;
      status: string;
      details: string | null;
      resolutionNote: string | null;
      resolvedByUserId: string | null;
      resolvedAt: Date | null;
    }>(
      `SELECT id, action_type AS actionType, status, details, resolution_note AS resolutionNote,
              resolved_by_user_id AS resolvedByUserId, resolved_at AS resolvedAt
         FROM clinic_closure_actions WHERE closure_request_id = ? ORDER BY id`,
      [requestId],
    );
  }

  private async lockClinic(tx: SqlExecutor, clinicId: string): Promise<Clinic> {
    const clinic = await this.deps.clinics.find(tx, clinicId, true);
    if (clinic === undefined) throw new NotFoundError('Clinic not found');
    return clinic;
  }

  private async findClosure(
    executor: SqlExecutor,
    id: string,
    clinicId?: string,
  ): Promise<ClosureRequest | undefined> {
    const rows = await executor.query<ClosureRow>(
      `SELECT * FROM clinic_closure_requests WHERE id = ? AND (? IS NULL OR clinic_id = ?)`,
      [id, clinicId ?? null, clinicId ?? null],
    );
    return rows[0] === undefined ? undefined : toClosure(rows[0]);
  }

  private async lockClosure(
    tx: SqlExecutor,
    id: string,
    clinicId?: string,
  ): Promise<ClosureRequest> {
    const rows = await tx.query<ClosureRow>(
      `SELECT * FROM clinic_closure_requests WHERE id = ? AND (? IS NULL OR clinic_id = ?) FOR UPDATE`,
      [id, clinicId ?? null, clinicId ?? null],
    );
    if (rows[0] === undefined) throw new NotFoundError('Closure request not found');
    return toClosure(rows[0]);
  }

  private async changeStatus(
    tx: SqlExecutor,
    clinic: Clinic,
    to: OperationalStatus,
    actorUserId: string,
    reason: string,
    meta: RequestMeta,
    reference: { type: string; id: string; scope?: SuspensionScope },
  ): Promise<void> {
    CLINIC_LIFECYCLE.assert(clinic.operationalStatus, to);
    await this.deps.clinics.setOperationalStatus(tx, clinic.id, to, this.deps.clock());
    await this.deps.clinics.insertHistory(tx, {
      clinicId: clinic.id,
      from: clinic.operationalStatus,
      to,
      actorUserId,
      reason,
      referenceType: reference.type,
      referenceId: reference.id,
    });
    await this.deps.auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.CLINIC_STATUS_CHANGED,
        actorUserId,
        targetType: 'CLINIC',
        targetId: clinic.id,
        clinicId: clinic.id,
        metadata: { from: clinic.operationalStatus, to, reason, reference },
      },
      meta,
    );
    await this.deps.outbox.record(tx, {
      type: `clinic.${to.toLowerCase()}`,
      aggregateType: 'clinic',
      aggregateId: clinic.id,
      clinicId: clinic.id,
      payload: {
        from: clinic.operationalStatus,
        to,
        ...(reference.scope === undefined ? {} : { scope: reference.scope }),
      },
    });
  }

  private async auditClosure(
    tx: SqlExecutor,
    id: string,
    clinicId: string,
    actorUserId: string,
    from: ClosureStatus | null,
    to: ClosureStatus,
    reason: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.CLOSURE_REQUEST_CHANGED,
        actorUserId,
        targetType: 'CLOSURE_REQUEST',
        targetId: id,
        clinicId,
        metadata: { from, to, reason },
      },
      meta,
    );
  }
}
