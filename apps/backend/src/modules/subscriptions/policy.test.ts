import { describe, expect, it } from 'vitest';
import {
  addBillingCycle,
  effectiveSubscription,
  permitsMarketplace,
  planFeaturesSchema,
  planLimitsSchema,
  SUBSCRIPTION_LIFECYCLE,
  type SubscriptionState,
} from './policy.js';

const DAY = 86_400_000;
const now = new Date('2026-06-15T12:00:00Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);
const state = (patch: Partial<SubscriptionState>): SubscriptionState => ({
  status: 'ACTIVE',
  trialEndsAt: null,
  currentPeriodEnd: at(10),
  pastDueSince: null,
  graceDays: 3,
  ...patch,
});

describe('effectiveSubscription', () => {
  it('no subscription is restricted (fail safe)', () => {
    expect(effectiveSubscription(null, now)).toMatchObject({
      status: 'NONE',
      permitsNewOperations: false,
    });
  });

  it('trial is valid until its end, then effectively EXPIRED', () => {
    expect(effectiveSubscription(state({ status: 'TRIAL', trialEndsAt: at(1) }), now).status).toBe(
      'TRIAL',
    );
    expect(
      effectiveSubscription(state({ status: 'TRIAL', trialEndsAt: at(-1) }), now),
    ).toMatchObject({ status: 'EXPIRED', permitsNewOperations: false });
  });

  it('ACTIVE past its period end counts as PAST_DUE with grace from the period end', () => {
    const e = effectiveSubscription(state({ currentPeriodEnd: at(-1) }), now);
    expect(e).toMatchObject({ status: 'PAST_DUE', permitsNewOperations: true });
    expect(e.graceEndsAt?.toISOString()).toBe(at(2).toISOString());
  });

  it('grace expiry makes the subscription effectively SUSPENDED even if the sweep has not run', () => {
    expect(effectiveSubscription(state({ currentPeriodEnd: at(-4) }), now)).toMatchObject({
      status: 'SUSPENDED',
      permitsNewOperations: false,
    });
    expect(
      effectiveSubscription(state({ status: 'PAST_DUE', pastDueSince: at(-4) }), now)
        .permitsNewOperations,
    ).toBe(false);
    expect(
      effectiveSubscription(state({ status: 'PAST_DUE', pastDueSince: at(-2) }), now)
        .permitsNewOperations,
    ).toBe(true);
  });

  it('respects a configurable grace period (including zero)', () => {
    expect(
      effectiveSubscription(state({ status: 'PAST_DUE', pastDueSince: at(-4), graceDays: 7 }), now)
        .permitsNewOperations,
    ).toBe(true);
    expect(
      effectiveSubscription(state({ status: 'PAST_DUE', pastDueSince: now, graceDays: 0 }), now)
        .permitsNewOperations,
    ).toBe(false);
  });

  it('SUSPENDED and EXPIRED never permit new operations', () => {
    for (const status of ['SUSPENDED', 'EXPIRED'] as const) {
      expect(effectiveSubscription(state({ status }), now).permitsNewOperations).toBe(false);
    }
  });
});

describe('plan catalog schemas', () => {
  it('require every feature and limit key and reject unknown keys', () => {
    expect(planFeaturesSchema.safeParse({ marketplace_listing: true }).success).toBe(true);
    expect(planFeaturesSchema.safeParse({}).success).toBe(false);
    expect(planFeaturesSchema.safeParse({ marketplace_listing: true, extra: 1 }).success).toBe(
      false,
    );
    expect(planLimitsSchema.safeParse({ max_branches: null, max_active_members: 5 }).success).toBe(
      true,
    );
    expect(planLimitsSchema.safeParse({ max_branches: 0, max_active_members: 5 }).success).toBe(
      false,
    );
  });

  it('marketplace needs good standing AND the plan feature', () => {
    const good = effectiveSubscription(state({}), now);
    expect(permitsMarketplace(good, { marketplace_listing: true })).toBe(true);
    expect(permitsMarketplace(good, { marketplace_listing: false })).toBe(false);
    expect(
      permitsMarketplace(effectiveSubscription(state({ status: 'EXPIRED' }), now), {
        marketplace_listing: true,
      }),
    ).toBe(false);
  });
});

describe('SUBSCRIPTION_LIFECYCLE and billing periods', () => {
  it('defines the allowed stored transitions', () => {
    expect(SUBSCRIPTION_LIFECYCLE.can('TRIAL', 'ACTIVE')).toBe(true);
    expect(SUBSCRIPTION_LIFECYCLE.can('ACTIVE', 'PAST_DUE')).toBe(true);
    expect(SUBSCRIPTION_LIFECYCLE.can('PAST_DUE', 'SUSPENDED')).toBe(true);
    expect(SUBSCRIPTION_LIFECYCLE.can('EXPIRED', 'ACTIVE')).toBe(true);
    expect(SUBSCRIPTION_LIFECYCLE.can('EXPIRED', 'TRIAL')).toBe(false);
    expect(SUBSCRIPTION_LIFECYCLE.can('ACTIVE', 'TRIAL')).toBe(false);
  });

  it('adds calendar months in UTC', () => {
    expect(addBillingCycle(new Date('2026-01-31T00:00:00Z'), 'MONTHLY').toISOString()).toBe(
      '2026-03-03T00:00:00.000Z',
    );
    expect(addBillingCycle(new Date('2026-02-01T00:00:00Z'), 'ANNUAL').toISOString()).toBe(
      '2027-02-01T00:00:00.000Z',
    );
  });
});
