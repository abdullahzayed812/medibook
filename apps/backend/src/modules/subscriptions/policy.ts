import { z } from 'zod';
import { defineStateMachine } from '../../shared/state-machine.js';

export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'EXPIRED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type BillingCycle = 'MONTHLY' | 'ANNUAL';

/**
 * Plan feature and limit catalog. Every plan version must define every key (strict), so
 * enforcement never guesses. Add a key here + a migration-free plan version to extend.
 * Limits: positive integer, or null = unlimited.
 */
export const planFeaturesSchema = z
  .object({
    /** Clinic may appear in the public Marketplace. */
    marketplace_listing: z.boolean(),
  })
  .strict();

export const planLimitsSchema = z
  .object({
    max_branches: z.number().int().min(1).max(10_000).nullable(),
    max_active_members: z.number().int().min(1).max(100_000).nullable(),
  })
  .strict();

export type PlanFeatures = z.infer<typeof planFeaturesSchema>;
export type PlanLimits = z.infer<typeof planLimitsSchema>;
export type LimitKey = keyof PlanLimits;

/** Stored-status transitions (time-based ones are applied by the lifecycle sweep). */
export const SUBSCRIPTION_LIFECYCLE = defineStateMachine<SubscriptionStatus>('Subscription', {
  TRIAL: ['ACTIVE', 'EXPIRED', 'SUSPENDED'],
  ACTIVE: ['PAST_DUE', 'SUSPENDED', 'EXPIRED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'EXPIRED'],
  SUSPENDED: ['ACTIVE', 'PAST_DUE', 'EXPIRED'],
  EXPIRED: ['ACTIVE'],
});

export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly pastDueSince: Date | null;
  /** Effective grace days (subscription override or platform default). */
  readonly graceDays: number;
}

export type EffectiveStatus = SubscriptionStatus | 'NONE';

export interface EffectiveSubscription {
  readonly status: EffectiveStatus;
  /** Grace period end while PAST_DUE. */
  readonly graceEndsAt: Date | null;
  /** True when new operational transactions are allowed. */
  readonly permitsNewOperations: boolean;
}

const DAY = 86_400_000;

/**
 * Derives the effective status from the stored state and dates at `now`. Enforcement always
 * uses this, never the raw stored status, so a delayed sweep cannot extend access:
 *   TRIAL past trial end → EXPIRED; ACTIVE past period end → PAST_DUE (grace counted from the
 *   period end); PAST_DUE past grace → SUSPENDED. No subscription → NONE (restricted).
 */
export function effectiveSubscription(
  state: SubscriptionState | null,
  now: Date,
): EffectiveSubscription {
  if (state === null) return { status: 'NONE', graceEndsAt: null, permitsNewOperations: false };
  const t = now.getTime();
  const pastDue = (since: Date): EffectiveSubscription => {
    const graceEndsAt = new Date(since.getTime() + state.graceDays * DAY);
    return t < graceEndsAt.getTime()
      ? { status: 'PAST_DUE', graceEndsAt, permitsNewOperations: true }
      : { status: 'SUSPENDED', graceEndsAt, permitsNewOperations: false };
  };
  switch (state.status) {
    case 'TRIAL':
      return state.trialEndsAt !== null && t < state.trialEndsAt.getTime()
        ? { status: 'TRIAL', graceEndsAt: null, permitsNewOperations: true }
        : { status: 'EXPIRED', graceEndsAt: null, permitsNewOperations: false };
    case 'ACTIVE':
      if (state.currentPeriodEnd !== null && t >= state.currentPeriodEnd.getTime()) {
        return pastDue(state.currentPeriodEnd);
      }
      return { status: 'ACTIVE', graceEndsAt: null, permitsNewOperations: true };
    case 'PAST_DUE':
      return pastDue(state.pastDueSince ?? now);
    case 'SUSPENDED':
    case 'EXPIRED':
      return { status: state.status, graceEndsAt: null, permitsNewOperations: false };
  }
}

/** Marketplace participation: subscription in good standing AND plan feature enabled. */
export function permitsMarketplace(
  effective: EffectiveSubscription,
  features: PlanFeatures | null,
): boolean {
  return effective.permitsNewOperations && features?.marketplace_listing === true;
}

export function addBillingCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + (cycle === 'MONTHLY' ? 1 : 12));
  return d;
}
