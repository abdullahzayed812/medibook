import type { SqlExecutor } from '../../infrastructure/database/database.js';
import type { BillingCycle, PlanFeatures, PlanLimits, SubscriptionStatus } from './policy.js';

export interface PlanVersion {
  readonly id: string;
  readonly planId: string;
  readonly version: number;
  readonly monthlyPriceMinor: string;
  readonly annualPriceMinor: string;
  readonly currency: string;
  readonly trialDays: number;
  readonly features: PlanFeatures;
  readonly limits: PlanLimits;
  readonly createdAt: Date;
}

export interface Plan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly currentVersion: PlanVersion | null;
}

export interface SubscriptionRecord {
  readonly id: string;
  readonly clinicId: string;
  readonly planId: string;
  readonly planVersionId: string;
  readonly status: SubscriptionStatus;
  readonly billingCycle: BillingCycle;
  readonly trialStartsAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly pastDueSince: Date | null;
  readonly gracePeriodDays: number | null;
  readonly statusChangedAt: Date;
}

interface VersionRow {
  id: string;
  plan_id: string;
  version: number;
  monthly_price_minor: string;
  annual_price_minor: string;
  currency: string;
  trial_days: number;
  features: PlanFeatures;
  limits: PlanLimits;
  created_at: Date;
}

const toVersion = (r: VersionRow): PlanVersion => ({
  id: r.id,
  planId: r.plan_id,
  version: r.version,
  monthlyPriceMinor: r.monthly_price_minor,
  annualPriceMinor: r.annual_price_minor,
  currency: r.currency,
  trialDays: r.trial_days,
  features: r.features,
  limits: r.limits,
  createdAt: r.created_at,
});

interface SubRow {
  id: string;
  clinic_id: string;
  plan_id: string;
  plan_version_id: string;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle;
  trial_starts_at: Date | null;
  trial_ends_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  past_due_since: Date | null;
  grace_period_days: number | null;
  status_changed_at: Date;
}

const toSub = (r: SubRow): SubscriptionRecord => ({
  id: r.id,
  clinicId: r.clinic_id,
  planId: r.plan_id,
  planVersionId: r.plan_version_id,
  status: r.status,
  billingCycle: r.billing_cycle,
  trialStartsAt: r.trial_starts_at,
  trialEndsAt: r.trial_ends_at,
  currentPeriodStart: r.current_period_start,
  currentPeriodEnd: r.current_period_end,
  pastDueSince: r.past_due_since,
  gracePeriodDays: r.grace_period_days,
  statusChangedAt: r.status_changed_at,
});

const SUB_COLUMNS = `id, clinic_id, plan_id, plan_version_id, status, billing_cycle, trial_starts_at, trial_ends_at,
  current_period_start, current_period_end, past_due_since, grace_period_days, status_changed_at`;

export class SubscriptionsRepository {
  async findVersion(executor: SqlExecutor, versionId: string): Promise<PlanVersion | undefined> {
    const rows = await executor.query<VersionRow>(
      'SELECT * FROM subscription_plan_versions WHERE id = ?',
      [versionId],
    );
    return rows[0] === undefined ? undefined : toVersion(rows[0]);
  }

  async listVersions(executor: SqlExecutor, planId: string): Promise<PlanVersion[]> {
    const rows = await executor.query<VersionRow>(
      'SELECT * FROM subscription_plan_versions WHERE plan_id = ? ORDER BY version',
      [planId],
    );
    return rows.map(toVersion);
  }

  async findPlan(
    executor: SqlExecutor,
    planId: string,
    forUpdate = false,
  ): Promise<Plan | undefined> {
    const rows = await executor.query<{
      id: string;
      code: string;
      name: string;
      description: string | null;
      status: 'ACTIVE' | 'INACTIVE';
      current_version_id: string | null;
    }>(
      `SELECT id, code, name, description, status, current_version_id FROM subscription_plans WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [planId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      currentVersion:
        row.current_version_id === null
          ? null
          : ((await this.findVersion(executor, row.current_version_id)) ?? null),
    };
  }

  /** Plans with their current version in one query (no N+1). */
  async listPlans(executor: SqlExecutor): Promise<Plan[]> {
    const rows = await executor.query<
      VersionRow & {
        p_id: string;
        code: string;
        name: string;
        description: string | null;
        status: 'ACTIVE' | 'INACTIVE';
        v_id: string | null;
      }
    >(
      `SELECT p.id AS p_id, p.code, p.name, p.description, p.status, v.id AS v_id, v.plan_id, v.version,
              v.monthly_price_minor, v.annual_price_minor, v.currency, v.trial_days, v.features, v.limits, v.created_at
         FROM subscription_plans p
         LEFT JOIN subscription_plan_versions v ON v.id = p.current_version_id
        ORDER BY p.id`,
    );
    return rows.map((r) => ({
      id: r.p_id,
      code: r.code,
      name: r.name,
      description: r.description,
      status: r.status,
      currentVersion: r.v_id === null ? null : toVersion({ ...r, id: r.v_id }),
    }));
  }

  async findByClinic(
    executor: SqlExecutor,
    clinicId: string,
    forUpdate = false,
  ): Promise<SubscriptionRecord | undefined> {
    const rows = await executor.query<SubRow>(
      `SELECT ${SUB_COLUMNS} FROM clinic_subscriptions WHERE clinic_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [clinicId],
    );
    return rows[0] === undefined ? undefined : toSub(rows[0]);
  }

  /** Candidates for the time-based sweep (re-checked under lock by the service). */
  async listDueForSweep(executor: SqlExecutor, now: Date, limit: number): Promise<string[]> {
    const rows = await executor.query<{ clinic_id: string }>(
      `SELECT clinic_id FROM clinic_subscriptions
        WHERE (status = 'TRIAL' AND trial_ends_at <= ?)
           OR (status = 'ACTIVE' AND current_period_end <= ?)
           OR status = 'PAST_DUE'
        ORDER BY id LIMIT ?`,
      [now, now, limit],
    );
    return rows.map((r) => r.clinic_id);
  }

  async update(executor: SqlExecutor, sub: SubscriptionRecord): Promise<void> {
    await executor.execute(
      `UPDATE clinic_subscriptions
          SET plan_id = ?, plan_version_id = ?, status = ?, billing_cycle = ?, trial_starts_at = ?, trial_ends_at = ?,
              current_period_start = ?, current_period_end = ?, past_due_since = ?, grace_period_days = ?,
              status_changed_at = ?
        WHERE id = ? AND clinic_id = ?`,
      [
        sub.planId,
        sub.planVersionId,
        sub.status,
        sub.billingCycle,
        sub.trialStartsAt,
        sub.trialEndsAt,
        sub.currentPeriodStart,
        sub.currentPeriodEnd,
        sub.pastDueSince,
        sub.gracePeriodDays,
        sub.statusChangedAt,
        sub.id,
        sub.clinicId,
      ],
    );
  }

  async insert(executor: SqlExecutor, sub: Omit<SubscriptionRecord, 'id'>): Promise<string> {
    const result = await executor.execute(
      `INSERT INTO clinic_subscriptions
         (clinic_id, plan_id, plan_version_id, status, billing_cycle, trial_starts_at, trial_ends_at,
          current_period_start, current_period_end, past_due_since, grace_period_days, status_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sub.clinicId,
        sub.planId,
        sub.planVersionId,
        sub.status,
        sub.billingCycle,
        sub.trialStartsAt,
        sub.trialEndsAt,
        sub.currentPeriodStart,
        sub.currentPeriodEnd,
        sub.pastDueSince,
        sub.gracePeriodDays,
        sub.statusChangedAt,
      ],
    );
    return String(result.insertId);
  }

  async insertHistory(
    executor: SqlExecutor,
    input: {
      sub: SubscriptionRecord;
      eventType: string;
      fromStatus: SubscriptionStatus | null;
      fromPlanVersionId: string | null;
      actorUserId: string | null;
      reason: string | null;
    },
  ): Promise<void> {
    await executor.execute(
      `INSERT INTO clinic_subscription_history
         (subscription_id, clinic_id, event_type, from_status, to_status, from_plan_version_id, to_plan_version_id,
          billing_cycle, period_start, period_end, actor_user_id, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sub.id,
        input.sub.clinicId,
        input.eventType,
        input.fromStatus,
        input.sub.status,
        input.fromPlanVersionId,
        input.sub.planVersionId,
        input.sub.billingCycle,
        input.sub.currentPeriodStart ?? input.sub.trialStartsAt,
        input.sub.currentPeriodEnd ?? input.sub.trialEndsAt,
        input.actorUserId,
        input.reason,
      ],
    );
  }

  async listHistory(
    executor: SqlExecutor,
    clinicId: string,
    page: { limit: number; cursor?: string | undefined },
  ) {
    return executor.query<{
      id: string;
      event_type: string;
      from_status: string | null;
      to_status: string;
      from_plan_version_id: string | null;
      to_plan_version_id: string;
      billing_cycle: string;
      period_start: Date | null;
      period_end: Date | null;
      actor_user_id: string | null;
      reason: string | null;
      created_at: Date;
    }>(
      `SELECT id, event_type, from_status, to_status, from_plan_version_id, to_plan_version_id, billing_cycle,
              period_start, period_end, actor_user_id, reason, created_at
         FROM clinic_subscription_history
        WHERE clinic_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      [clinicId, page.cursor ?? null, page.cursor ?? null, page.limit + 1],
    );
  }
}
