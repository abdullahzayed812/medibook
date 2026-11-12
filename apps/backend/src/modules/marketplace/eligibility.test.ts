import { describe, expect, it } from 'vitest';
import type { ClinicSubscriptionState } from '../subscriptions/index.js';
import { evaluateMarketplaceEligibility } from './marketplace.service.js';

const good: Pick<ClinicSubscriptionState, 'effective' | 'features'> = {
  effective: { status: 'ACTIVE', graceEndsAt: null, permitsNewOperations: true },
  features: { marketplace_listing: true },
};
const clinic = {
  approvedAt: new Date(),
  operationalStatus: 'ACTIVE' as const,
  publicVisibility: true,
};

describe('evaluateMarketplaceEligibility', () => {
  it('is eligible only when every condition holds', () => {
    expect(
      evaluateMarketplaceEligibility({ clinic, suspensionOpen: false, subscription: good }),
    ).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    ['REGISTRATION_NOT_APPROVED', { clinic: { ...clinic, approvedAt: null } }],
    ['CLINIC_NOT_ACTIVE', { clinic: { ...clinic, operationalStatus: 'CLOSING' as const } }],
    ['CLINIC_SUSPENDED', { suspensionOpen: true }],
    [
      'SUBSCRIPTION_NOT_ELIGIBLE',
      {
        subscription: {
          ...good,
          effective: { status: 'EXPIRED' as const, graceEndsAt: null, permitsNewOperations: false },
        },
      },
    ],
    [
      'PLAN_EXCLUDES_MARKETPLACE',
      { subscription: { ...good, features: { marketplace_listing: false } } },
    ],
    ['VISIBILITY_DISABLED', { clinic: { ...clinic, publicVisibility: false } }],
  ])('reports %s', (reason, patch) => {
    const result = evaluateMarketplaceEligibility({
      clinic,
      suspensionOpen: false,
      subscription: good,
      ...patch,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it('reports all unmet conditions at once', () => {
    const result = evaluateMarketplaceEligibility({
      clinic: { approvedAt: null, operationalStatus: 'CLOSED', publicVisibility: false },
      suspensionOpen: false,
      subscription: {
        effective: { status: 'NONE', graceEndsAt: null, permitsNewOperations: false },
        features: null,
      },
    });
    expect(result.reasons).toEqual([
      'REGISTRATION_NOT_APPROVED',
      'CLINIC_NOT_ACTIVE',
      'SUBSCRIPTION_NOT_ELIGIBLE',
      'VISIBILITY_DISABLED',
    ]);
  });
});
