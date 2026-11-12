import { z } from 'zod';
import { must } from '../../shared/must.js';
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
import type { AuthorizationService, Principal, TenantContext } from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import type { DomainEventOutbox, PlatformSettingsService } from '../platform/index.js';
import {
  addBillingCycle,
  effectiveSubscription,
  planFeaturesSchema,
  planLimitsSchema,
  SUBSCRIPTION_LIFECYCLE,
  type BillingCycle,
  type EffectiveSubscription,
  type LimitKey,
  type PlanFeatures,
  type PlanLimits,
} from './policy.js';
import type {
  Plan,
  PlanVersion,
  SubscriptionRecord,
  SubscriptionsRepository,
} from './subscriptions.repository.js';

export const planVersionInputSchema = z
  .object({
    monthlyPriceMinor: z.number().int().min(0).max(1e12),
    annualPriceMinor: z.number().int().min(0).max(1e13),
    currency: z.string().regex(/^[A-Z]{3}$/),
    trialDays: z.number().int().min(0).max(365),
    features: planFeaturesSchema,
    limits: planLimitsSchema,
  })
  .strict();
export type PlanVersionInput = z.infer<typeof planVersionInputSchema>;

export const planCreateSchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)
      .max(50),
    name: z.string().trim().min(2).max(150),
    description: z.string().trim().max(1000).optional(),
    terms: planVersionInputSchema,
  })
  .strict();

export interface SubscriptionView {
  readonly subscription: SubscriptionRecord;
  readonly plan: { id: string; code: string; name: string };
  readonly planVersion: PlanVersion;
  readonly effective: EffectiveSubscription;
  readonly marketplaceAllowed: boolean;
}

/** Everything the gate, entitlements and marketplace need about a clinic's subscription. */
export interface ClinicSubscriptionState {
  readonly record: SubscriptionRecord | null;
  readonly effective: EffectiveSubscription;
  readonly features: PlanFeatures | null;
  readonly limits: PlanLimits | null;
}

export interface SubscriptionDeps {
  readonly db: Database;
  readonly repo: SubscriptionsRepository;
  readonly authz: AuthorizationService;
  readonly settings: PlatformSettingsService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
  readonly clock: Clock;
}

/** Plan catalog (Super Admin). Versions are immutable; edits create a new version. */
export class PlansService {
  constructor(private readonly deps: SubscriptionDeps) {}

  list(): Promise<Plan[]> {
    return this.deps.repo.listPlans(this.deps.db);
  }

  async get(actor: Principal, planId: string): Promise<{ plan: Plan; versions: PlanVersion[] }> {
    await this.deps.authz.assert(actor, 'platform.plans.manage');
    const plan = await this.deps.repo.findPlan(this.deps.db, planId);
    if (plan === undefined) throw new NotFoundError('Plan not found');
    return { plan, versions: await this.deps.repo.listVersions(this.deps.db, planId) };
  }

  async create(
    actor: Principal,
    input: z.infer<typeof planCreateSchema>,
    meta: RequestMeta,
  ): Promise<Plan> {
    await this.deps.authz.assert(actor, 'platform.plans.manage');
    return this.deps.db.transaction(async (tx) => {
      const existing = await tx.query('SELECT id FROM subscription_plans WHERE code = ?', [
        input.code,
      ]);
      if (existing.length > 0) throw new ConflictError('A plan with this code already exists');
      const planId = String(
        (
          await tx.execute(
            'INSERT INTO subscription_plans (code, name, description) VALUES (?, ?, ?)',
            [input.code, input.name, input.description ?? null],
          )
        ).insertId,
      );
      await this.insertVersion(tx, planId, 1, input.terms, actor.userId);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.PLAN_CREATED,
          actorUserId: actor.userId,
          targetType: 'PLAN',
          targetId: planId,
          metadata: { code: input.code, terms: input.terms },
        },
        meta,
      );
      return must(await this.deps.repo.findPlan(tx, planId), 'plan');
    });
  }

  /** New pricing/features/limits for future assignments; existing subscriptions keep their version. */
  async addVersion(
    actor: Principal,
    planId: string,
    terms: PlanVersionInput,
    meta: RequestMeta,
  ): Promise<PlanVersion> {
    await this.deps.authz.assert(actor, 'platform.plans.manage');
    return this.deps.db.transaction(async (tx) => {
      const plan = await this.deps.repo.findPlan(tx, planId, true);
      if (plan === undefined) throw new NotFoundError('Plan not found');
      const next = (plan.currentVersion?.version ?? 0) + 1;
      const versionId = await this.insertVersion(tx, planId, next, terms, actor.userId);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.PLAN_VERSION_CREATED,
          actorUserId: actor.userId,
          targetType: 'PLAN',
          targetId: planId,
          metadata: { version: next, before: plan.currentVersion, after: terms },
        },
        meta,
      );
      return must(await this.deps.repo.findVersion(tx, versionId), 'plan version');
    });
  }

  async setStatus(
    actor: Principal,
    planId: string,
    status: 'ACTIVE' | 'INACTIVE',
    meta: RequestMeta,
  ): Promise<void> {
    await this.deps.authz.assert(actor, 'platform.plans.manage');
    await this.deps.db.transaction(async (tx) => {
      const plan = await this.deps.repo.findPlan(tx, planId, true);
      if (plan === undefined) throw new NotFoundError('Plan not found');
      await tx.execute('UPDATE subscription_plans SET status = ? WHERE id = ?', [status, planId]);
      await this.deps.auditLog.record(
        tx,
        {
          action: AUDIT_ACTION.PLAN_STATUS_CHANGED,
          actorUserId: actor.userId,
          targetType: 'PLAN',
          targetId: planId,
          metadata: { from: plan.status, to: status },
        },
        meta,
      );
    });
  }

  private async insertVersion(
    tx: SqlExecutor,
    planId: string,
    version: number,
    terms: PlanVersionInput,
    actorId: string,
  ): Promise<string> {
    const versionId = String(
      (
        await tx.execute(
          `INSERT INTO subscription_plan_versions
             (plan_id, version, monthly_price_minor, annual_price_minor, currency, trial_days, features, limits, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            planId,
            version,
            terms.monthlyPriceMinor,
            terms.annualPriceMinor,
            terms.currency,
            terms.trialDays,
            JSON.stringify(terms.features),
            JSON.stringify(terms.limits),
            actorId,
          ],
        )
      ).insertId,
    );
    await tx.execute('UPDATE subscription_plans SET current_version_id = ? WHERE id = ?', [
      versionId,
      planId,
    ]);
    return versionId;
  }
}

/**
 * Clinic subscriptions: lifecycle, history, entitlements and the time-based sweep.
 * All state changes write clinic_subscription_history + audit + a domain event (billing seam).
 */
export class SubscriptionService {
  constructor(private readonly deps: SubscriptionDeps) {}

  /** State used for enforcement (gate, entitlements, marketplace). */
  async stateFor(executor: SqlExecutor, clinicId: string): Promise<ClinicSubscriptionState> {
    const record = (await this.deps.repo.findByClinic(executor, clinicId)) ?? null;
    if (record === null)
      return {
        record,
        effective: effectiveSubscription(null, this.deps.clock()),
        features: null,
        limits: null,
      };
    const version = await this.deps.repo.findVersion(executor, record.planVersionId);
    const graceDays =
      record.gracePeriodDays ??
      (await this.deps.settings.get('subscription.grace_period_days', executor));
    return {
      record,
      effective: effectiveSubscription({ ...record, graceDays }, this.deps.clock()),
      features: version?.features ?? null,
      limits: version?.limits ?? null,
    };
  }

  /** Clinic side: clinic.subscription.view in the verified clinic context. */
  async viewForClinic(actor: Principal, tenant: TenantContext): Promise<SubscriptionView | null> {
    await this.deps.authz.assert(actor, 'clinic.subscription.view', { tenant });
    return this.view(tenant.clinicId);
  }

  async historyForClinic(
    actor: Principal,
    tenant: TenantContext,
    page: { limit: number; cursor?: string | undefined },
  ) {
    await this.deps.authz.assert(actor, 'clinic.subscription.view', { tenant });
    return this.history(tenant.clinicId, page);
  }

  async viewForPlatform(actor: Principal, clinicId: string): Promise<SubscriptionView | null> {
    await this.deps.authz.assert(actor, 'platform.subscriptions.manage');
    return this.view(clinicId);
  }

  async historyForPlatform(
    actor: Principal,
    clinicId: string,
    page: { limit: number; cursor?: string | undefined },
  ) {
    await this.deps.authz.assert(actor, 'platform.subscriptions.manage');
    return this.history(clinicId, page);
  }

  async view(clinicId: string): Promise<SubscriptionView | null> {
    const state = await this.stateFor(this.deps.db, clinicId);
    if (state.record === null) return null;
    const plan = await this.deps.repo.findPlan(this.deps.db, state.record.planId);
    const version = await this.deps.repo.findVersion(this.deps.db, state.record.planVersionId);
    if (plan === undefined || version === undefined)
      throw new Error('Subscription references a missing plan');
    return {
      subscription: state.record,
      plan: { id: plan.id, code: plan.code, name: plan.name },
      planVersion: version,
      effective: state.effective,
      marketplaceAllowed:
        state.effective.permitsNewOperations && version.features.marketplace_listing,
    };
  }

  private async history(clinicId: string, page: { limit: number; cursor?: string | undefined }) {
    const rows = await this.deps.repo.listHistory(this.deps.db, clinicId, page);
    return toPage(
      rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        fromPlanVersionId: r.from_plan_version_id,
        toPlanVersionId: r.to_plan_version_id,
        billingCycle: r.billing_cycle,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        actorUserId: r.actor_user_id,
        reason: r.reason,
        createdAt: r.created_at,
      })),
      page.limit,
    );
  }

  /**
   * Creates the subscription of a newly approved clinic, inside the approval transaction.
   * Trial when the plan version has trial days; otherwise payment is due immediately (PAST_DUE,
   * grace period applies).
   */
  async createForNewClinic(
    tx: SqlExecutor,
    input: { clinicId: string; planId: string; billingCycle: BillingCycle; actorUserId: string },
    meta: RequestMeta,
  ): Promise<string> {
    const plan = await this.deps.repo.findPlan(tx, input.planId);
    if (plan?.status !== 'ACTIVE' || plan.currentVersion === null) {
      throw new ValidationError(
        [{ location: 'body', path: 'planId', message: 'Plan is not available' }],
        'Plan is not available',
      );
    }
    const now = this.deps.clock();
    const trialDays = plan.currentVersion.trialDays;
    const record: Omit<SubscriptionRecord, 'id'> = {
      clinicId: input.clinicId,
      planId: plan.id,
      planVersionId: plan.currentVersion.id,
      status: trialDays > 0 ? 'TRIAL' : 'PAST_DUE',
      billingCycle: input.billingCycle,
      trialStartsAt: trialDays > 0 ? now : null,
      trialEndsAt: trialDays > 0 ? new Date(now.getTime() + trialDays * 86_400_000) : null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      pastDueSince: trialDays > 0 ? null : now,
      gracePeriodDays: null,
      statusChangedAt: now,
    };
    const id = await this.deps.repo.insert(tx, record);
    const sub = { ...record, id };
    await this.deps.repo.insertHistory(tx, {
      sub,
      eventType: trialDays > 0 ? 'TRIAL_STARTED' : 'CREATED',
      fromStatus: null,
      fromPlanVersionId: null,
      actorUserId: input.actorUserId,
      reason: 'Clinic approved',
    });
    await this.deps.auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.SUBSCRIPTION_CREATED,
        actorUserId: input.actorUserId,
        targetType: 'SUBSCRIPTION',
        targetId: id,
        clinicId: input.clinicId,
        metadata: { planVersionId: sub.planVersionId, status: sub.status },
      },
      meta,
    );
    await this.deps.outbox.record(tx, {
      type: 'subscription.created',
      aggregateType: 'subscription',
      aggregateId: id,
      clinicId: input.clinicId,
      payload: { status: sub.status, planVersionId: sub.planVersionId },
    });
    return id;
  }

  /**
   * Billing seam: records a successful payment (today entered by a Super Admin; later called by
   * the payment-gateway webhook handler). Renews an in-period ACTIVE subscription from its period
   * end; otherwise starts a fresh period now.
   */
  async recordPayment(
    actor: Principal,
    clinicId: string,
    input: { billingCycle?: BillingCycle | undefined; reference?: string | undefined },
    meta: RequestMeta,
  ): Promise<SubscriptionRecord> {
    await this.deps.authz.assert(actor, 'platform.subscriptions.manage');
    return this.mutate(clinicId, actor.userId, meta, (sub, now) => {
      const cycle = input.billingCycle ?? sub.billingCycle;
      const renew =
        sub.status === 'ACTIVE' && sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now;
      if (!renew && sub.status !== 'ACTIVE') SUBSCRIPTION_LIFECYCLE.assert(sub.status, 'ACTIVE');
      const start = renew ? sub.currentPeriodEnd : now;
      return {
        next: {
          ...sub,
          status: 'ACTIVE',
          billingCycle: cycle,
          currentPeriodStart: start,
          currentPeriodEnd: addBillingCycle(start, cycle),
          pastDueSince: null,
          statusChangedAt: renew ? sub.statusChangedAt : now,
        },
        eventType: renew ? 'RENEWED' : 'ACTIVATED',
        reason:
          input.reference === undefined
            ? 'Payment recorded'
            : `Payment recorded (${input.reference})`,
      };
    });
  }

  async changePlan(
    actor: Principal,
    clinicId: string,
    planId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<SubscriptionRecord> {
    await this.deps.authz.assert(actor, 'platform.subscriptions.manage');
    const plan = await this.deps.repo.findPlan(this.deps.db, planId);
    if (plan?.status !== 'ACTIVE' || plan.currentVersion === null)
      throw new ConflictError('Plan is not available');
    const version = plan.currentVersion;
    return this.mutate(clinicId, actor.userId, meta, (sub) => {
      if (sub.planVersionId === version.id)
        throw new ConflictError('The subscription already uses this plan version');
      return {
        next: { ...sub, planId: plan.id, planVersionId: version.id },
        eventType: 'PLAN_CHANGED',
        reason,
      };
    });
  }

  async setStatus(
    actor: Principal,
    clinicId: string,
    status: 'SUSPENDED' | 'EXPIRED',
    reason: string,
    meta: RequestMeta,
  ): Promise<SubscriptionRecord> {
    await this.deps.authz.assert(actor, 'platform.subscriptions.manage');
    return this.mutate(clinicId, actor.userId, meta, (sub, now) => {
      SUBSCRIPTION_LIFECYCLE.assert(sub.status, status);
      return { next: { ...sub, status, statusChangedAt: now }, eventType: status, reason };
    });
  }

  /** Lifts an administrative suspension: ACTIVE if the paid period is still running, else PAST_DUE. */
  async reactivate(
    actor: Principal,
    clinicId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<SubscriptionRecord> {
    await this.deps.authz.assert(actor, 'platform.subscriptions.manage');
    return this.mutate(clinicId, actor.userId, meta, (sub, now) => {
      if (sub.status !== 'SUSPENDED')
        throw new AppError(
          409,
          'INVALID_TRANSITION',
          'Only suspended subscriptions can be reactivated',
        );
      const inPeriod = sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now;
      return {
        next: {
          ...sub,
          status: inPeriod ? 'ACTIVE' : 'PAST_DUE',
          pastDueSince: inPeriod ? null : now,
          statusChangedAt: now,
        },
        eventType: 'REACTIVATED',
        reason,
      };
    });
  }

  async setGracePeriod(
    actor: Principal,
    clinicId: string,
    days: number | null,
    reason: string,
    meta: RequestMeta,
  ): Promise<SubscriptionRecord> {
    await this.deps.authz.assert(actor, 'platform.subscriptions.manage');
    return this.mutate(clinicId, actor.userId, meta, (sub) => ({
      next: { ...sub, gracePeriodDays: days },
      eventType: 'GRACE_PERIOD_CHANGED',
      reason,
    }));
  }

  /** Clinic closure ends the subscription (inside the closure transaction). */
  async expireForClosure(
    tx: SqlExecutor,
    clinicId: string,
    actorUserId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const sub = await this.deps.repo.findByClinic(tx, clinicId, true);
    if (sub === undefined || sub.status === 'EXPIRED') return;
    await this.apply(
      tx,
      sub,
      {
        next: { ...sub, status: 'EXPIRED', statusChangedAt: this.deps.clock() },
        eventType: 'EXPIRED',
        reason: 'Clinic closed',
      },
      actorUserId,
      meta,
    );
  }

  /**
   * Time-based transitions (run periodically by the worker; idempotent):
   *   TRIAL past trial end → EXPIRED; ACTIVE past period end → PAST_DUE (since period end);
   *   PAST_DUE past grace → SUSPENDED (GRACE_EXPIRED).
   */
  async sweep(meta: RequestMeta, batchSize = 200): Promise<{ changed: number }> {
    const now = this.deps.clock();
    let changed = 0;
    for (const clinicId of await this.deps.repo.listDueForSweep(this.deps.db, now, batchSize)) {
      const did = await this.deps.db.transaction(async (tx) => {
        const sub = await this.deps.repo.findByClinic(tx, clinicId, true);
        if (sub === undefined) return false;
        const graceDays =
          sub.gracePeriodDays ??
          (await this.deps.settings.get('subscription.grace_period_days', tx));
        const effective = effectiveSubscription({ ...sub, graceDays }, now);
        const target = effective.status === 'NONE' ? sub.status : effective.status;
        if (target === sub.status) return false;
        const next: SubscriptionRecord =
          target === 'PAST_DUE'
            ? {
                ...sub,
                status: 'PAST_DUE',
                pastDueSince: sub.currentPeriodEnd ?? now,
                statusChangedAt: now,
              }
            : target === 'SUSPENDED'
              ? {
                  ...sub,
                  status: 'SUSPENDED',
                  pastDueSince: sub.pastDueSince ?? sub.currentPeriodEnd ?? now,
                  statusChangedAt: now,
                }
              : { ...sub, status: target, statusChangedAt: now };
        const eventType =
          target === 'SUSPENDED'
            ? 'GRACE_EXPIRED'
            : target === 'PAST_DUE'
              ? 'MARKED_PAST_DUE'
              : 'TRIAL_ENDED';
        await this.apply(
          tx,
          sub,
          { next, eventType, reason: 'Automatic lifecycle sweep' },
          null,
          meta,
        );
        return true;
      });
      if (did) changed++;
    }
    return { changed };
  }

  /** Entitlement check for growth (new branch / newly active member). */
  async assertCanGrow(tx: SqlExecutor, clinicId: string, limit: LimitKey): Promise<void> {
    const state = await this.stateFor(tx, clinicId);
    if (!state.effective.permitsNewOperations) {
      throw new AppError(
        403,
        'SUBSCRIPTION_INACTIVE',
        'The clinic subscription does not allow this operation',
        { details: { subscriptionStatus: state.effective.status } },
      );
    }
    const max = state.limits?.[limit] ?? null;
    if (max === null) return;
    const sql =
      limit === 'max_branches'
        ? `SELECT COUNT(*) AS n FROM clinic_branches WHERE clinic_id = ? AND status = 'ACTIVE'`
        : `SELECT COUNT(DISTINCT user_id) AS n FROM clinic_memberships WHERE clinic_id = ? AND status = 'ACTIVE'`;
    const [row] = await tx.query<{ n: string }>(sql, [clinicId]);
    if (Number(row?.n ?? 0) >= max) {
      throw new AppError(
        409,
        'PLAN_LIMIT_REACHED',
        `The plan limit ${limit} (${max}) has been reached`,
        { details: { limit, max } },
      );
    }
  }

  private async mutate(
    clinicId: string,
    actorUserId: string,
    meta: RequestMeta,
    change: (
      sub: SubscriptionRecord,
      now: Date,
    ) => { next: SubscriptionRecord; eventType: string; reason: string },
  ): Promise<SubscriptionRecord> {
    return this.deps.db.transaction(async (tx) => {
      const sub = await this.deps.repo.findByClinic(tx, clinicId, true);
      if (sub === undefined) throw new NotFoundError('Subscription not found');
      const result = change(sub, this.deps.clock());
      await this.apply(tx, sub, result, actorUserId, meta);
      return result.next;
    });
  }

  private async apply(
    tx: SqlExecutor,
    before: SubscriptionRecord,
    result: { next: SubscriptionRecord; eventType: string; reason: string },
    actorUserId: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    const { next } = result;
    await this.deps.repo.update(tx, next);
    await this.deps.repo.insertHistory(tx, {
      sub: next,
      eventType: result.eventType,
      fromStatus: before.status,
      fromPlanVersionId: before.planVersionId === next.planVersionId ? null : before.planVersionId,
      actorUserId,
      reason: result.reason,
    });
    await this.deps.auditLog.record(
      tx,
      {
        action: AUDIT_ACTION.SUBSCRIPTION_CHANGED,
        actorUserId,
        targetType: 'SUBSCRIPTION',
        targetId: next.id,
        clinicId: next.clinicId,
        metadata: {
          event: result.eventType,
          reason: result.reason,
          before: snapshot(before),
          after: snapshot(next),
        },
      },
      meta,
    );
    await this.deps.outbox.record(tx, {
      type: `subscription.${result.eventType.toLowerCase()}`,
      aggregateType: 'subscription',
      aggregateId: next.id,
      clinicId: next.clinicId,
      payload: {
        fromStatus: before.status,
        toStatus: next.status,
        planVersionId: next.planVersionId,
      },
    });
  }
}

function snapshot(sub: SubscriptionRecord): Record<string, unknown> {
  return {
    status: sub.status,
    planVersionId: sub.planVersionId,
    billingCycle: sub.billingCycle,
    currentPeriodEnd: sub.currentPeriodEnd,
    trialEndsAt: sub.trialEndsAt,
    gracePeriodDays: sub.gracePeriodDays,
  };
}
