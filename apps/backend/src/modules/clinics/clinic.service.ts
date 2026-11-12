import { must } from '../../shared/must.js';
import type { Database } from '../../infrastructure/database/database.js';
import { AppError, NotFoundError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import {
  tenantExecutor,
  type AuthorizationService,
  type Principal,
  type TenantContext,
} from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { DomainEventOutbox } from '../platform/index.js';
import type { SubscriptionService } from '../subscriptions/index.js';
import type { Branch, BranchesRepository } from './branches.repository.js';
import type { Clinic, ClinicsRepository } from './clinics.repository.js';
import type { ClinicOperationGateImpl } from './operation-gate.js';
import { toColumns, type BranchInput, type ClinicProfilePatch } from './schemas.js';

export interface ClinicServiceDeps {
  readonly db: Database;
  readonly clinics: ClinicsRepository;
  readonly branches: BranchesRepository;
  readonly authz: AuthorizationService;
  readonly gate: ClinicOperationGateImpl;
  readonly subscriptions: SubscriptionService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
}

/** Clinic profile and branch management for clinic actors (inside a verified TenantContext). */
export class ClinicService {
  constructor(private readonly deps: ClinicServiceDeps) {}

  async profile(actor: Principal, tenant: TenantContext) {
    await this.deps.authz.assert(actor, 'clinic.profile.view', { tenant });
    const clinic = await this.load(tenant.clinicId);
    const state = await this.deps.gate.state(tenant.clinicId, null);
    return {
      clinic,
      operatingState: {
        operationalStatus: state.operationalStatus,
        suspensionScope: state.suspensionScope,
        subscriptionStatus: state.subscription.status,
        newOperationsAllowed:
          state.subscription.permitsNewOperations &&
          state.suspensionScope === null &&
          clinic.operationalStatus === 'ACTIVE',
      },
    };
  }

  async updateProfile(
    actor: Principal,
    tenant: TenantContext,
    patch: ClinicProfilePatch,
    meta: RequestMeta,
  ): Promise<Clinic> {
    await this.deps.authz.assert(actor, 'clinic.profile.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      const before = await this.load(tenant.clinicId, tx, true);
      await this.deps.clinics.update(tx, tenant.clinicId, toColumns(patch));
      const after = await this.load(tenant.clinicId, tx);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.CLINIC_PROFILE_UPDATED,
          actorUserId: actor.userId,
          targetType: 'CLINIC',
          targetId: tenant.clinicId,
          clinicId: tenant.clinicId,
          metadata: {
            changed: Object.keys(patch),
            before: pick(before, patch),
            after: pick(after, patch),
          },
        },
        meta,
      );
      return after;
    });
  }

  /** Branches the caller covers (all for ALL-scope members, else the assigned ones). */
  async listBranches(actor: Principal, tenant: TenantContext): Promise<Branch[]> {
    await this.deps.authz.assert(actor, 'clinic.branches.view', { tenant });
    return this.deps.branches.list(this.deps.db, tenant.scope, coverage(tenant));
  }

  async getBranch(actor: Principal, tenant: TenantContext, branchId: string): Promise<Branch> {
    await this.deps.authz.assert(actor, 'clinic.branches.view', { tenant });
    const cover = coverage(tenant);
    const branch =
      cover === 'ALL' || cover.includes(branchId)
        ? await this.deps.branches.find(this.deps.db, tenant.scope, branchId)
        : undefined;
    if (branch === undefined) throw new NotFoundError('Branch not found');
    return branch;
  }

  async createBranch(
    actor: Principal,
    tenant: TenantContext,
    input: BranchInput,
    meta: RequestMeta,
  ): Promise<Branch> {
    await this.deps.authz.assert(actor, 'clinic.branches.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.load(tenant.clinicId, tx, true); // serialize branch-limit checks per clinic
      await this.deps.subscriptions.assertCanGrow(tx, tenant.clinicId, 'max_branches');
      const branchId = await this.deps.branches.insert(tx, tenant.scope, toColumns(input));
      const branch = must(await this.deps.branches.find(tx, tenant.scope, branchId), 'branch');
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.BRANCH_CREATED,
          actorUserId: actor.userId,
          targetType: 'BRANCH',
          targetId: branchId,
          clinicId: tenant.clinicId,
          metadata: { name: branch.name },
        },
        meta,
      );
      return branch;
    });
  }

  async updateBranch(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    patch: Partial<BranchInput>,
    meta: RequestMeta,
  ): Promise<Branch> {
    await this.deps.authz.assert(actor, 'clinic.branches.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      const before = await this.deps.branches.find(tx, tenant.scope, branchId, true);
      if (before === undefined) throw new NotFoundError('Branch not found');
      // Task 04: schedules are wall-clock times in the branch time zone; changing the zone would
      // silently move every period in real time. Refuse while schedules or exceptions are active.
      if (patch.timeZone !== undefined && patch.timeZone !== before.timeZone) {
        const inUse = await tenantExecutor(tx, tenant.scope).query(
          `SELECT id FROM schedules WHERE clinic_id = ? AND branch_id = ? AND status = 'ACTIVE'
           UNION ALL SELECT id FROM schedule_exceptions WHERE clinic_id = ? AND branch_id = ? AND status = 'ACTIVE'
           LIMIT 1`,
          [tenant.clinicId, branchId, tenant.clinicId, branchId],
        );
        if (inUse.length > 0)
          throw new AppError(
            409,
            'BRANCH_TIME_ZONE_LOCKED',
            'The time zone cannot change while the branch has active schedules or exceptions',
          );
      }
      await this.deps.branches.update(tx, tenant.scope, branchId, toColumns(patch));
      const after = must(await this.deps.branches.find(tx, tenant.scope, branchId), 'branch');
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.BRANCH_UPDATED,
          actorUserId: actor.userId,
          targetType: 'BRANCH',
          targetId: branchId,
          clinicId: tenant.clinicId,
          metadata: { changed: Object.keys(patch) },
        },
        meta,
      );
      return after;
    });
  }

  async setBranchStatus(
    actor: Principal,
    tenant: TenantContext,
    branchId: string,
    status: 'ACTIVE' | 'INACTIVE',
    meta: RequestMeta,
  ): Promise<Branch> {
    await this.deps.authz.assert(actor, 'clinic.branches.manage', { tenant });
    return this.deps.db.transaction(async (tx) => {
      await this.load(tenant.clinicId, tx, true);
      const before = await this.deps.branches.find(tx, tenant.scope, branchId, true);
      if (before === undefined) throw new NotFoundError('Branch not found');
      if (before.status === status) return before;
      if (status === 'ACTIVE')
        await this.deps.subscriptions.assertCanGrow(tx, tenant.clinicId, 'max_branches');
      await this.deps.branches.update(tx, tenant.scope, branchId, { status });
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.BRANCH_STATUS_CHANGED,
          actorUserId: actor.userId,
          targetType: 'BRANCH',
          targetId: branchId,
          clinicId: tenant.clinicId,
          metadata: { from: before.status, to: status },
        },
        meta,
      );
      return { ...before, status };
    });
  }

  private async load(
    clinicId: string,
    executor = this.deps.db as Parameters<ClinicsRepository['find']>[0],
    forUpdate = false,
  ): Promise<Clinic> {
    const clinic = await this.deps.clinics.find(executor, clinicId, forUpdate);
    if (clinic === undefined) throw new NotFoundError('Clinic not found');
    return clinic;
  }
}

export function coverage(tenant: TenantContext): readonly string[] | 'ALL' {
  return tenant.memberships.some((m) => m.branchScope === 'ALL')
    ? 'ALL'
    : [...new Set(tenant.memberships.flatMap((m) => m.branchIds))];
}

function pick(clinic: Clinic, patch: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(patch).map((k) => [k, (clinic as unknown as Record<string, unknown>)[k]]),
  );
}
