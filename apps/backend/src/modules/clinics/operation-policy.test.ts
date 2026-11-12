import { describe, expect, it } from 'vitest';
import type { OperationCategory } from '../access/index.js';
import type { EffectiveSubscription } from '../subscriptions/index.js';
import {
  CLINIC_LIFECYCLE,
  evaluateClinicOperation,
  type ClinicOperatingState,
} from './operation-policy.js';

const goodSub: EffectiveSubscription = {
  status: 'ACTIVE',
  graceEndsAt: null,
  permitsNewOperations: true,
};
const badSub: EffectiveSubscription = {
  status: 'SUSPENDED',
  graceEndsAt: null,
  permitsNewOperations: false,
};
const base: ClinicOperatingState = {
  operationalStatus: 'ACTIVE',
  suspensionScope: null,
  subscription: goodSub,
  branchStatus: null,
};
const CATEGORIES: OperationCategory[] = [
  'CLINIC_INFO',
  'READ',
  'CONTINUITY_OF_CARE',
  'ADMINISTRATION',
  'NEW_OPERATION',
  'LIFECYCLE',
];

/** Expected matrix (✅ = allowed) — mirrors the table in operation-policy.ts and CLINIC_LIFECYCLE.md. */
const MATRIX: [
  string,
  Partial<ClinicOperatingState>,
  boolean,
  Record<OperationCategory, boolean>,
][] = [
  [
    'ACTIVE',
    {},
    false,
    {
      CLINIC_INFO: true,
      READ: true,
      CONTINUITY_OF_CARE: true,
      ADMINISTRATION: true,
      NEW_OPERATION: true,
      LIFECYCLE: true,
    },
  ],
  [
    'suspension NEW_OPERATIONS',
    { operationalStatus: 'SUSPENDED', suspensionScope: 'NEW_OPERATIONS' },
    false,
    {
      CLINIC_INFO: true,
      READ: true,
      CONTINUITY_OF_CARE: true,
      ADMINISTRATION: true,
      NEW_OPERATION: false,
      LIFECYCLE: true,
    },
  ],
  [
    'suspension FULL',
    { operationalStatus: 'SUSPENDED', suspensionScope: 'FULL' },
    false,
    {
      CLINIC_INFO: true,
      READ: false,
      CONTINUITY_OF_CARE: false,
      ADMINISTRATION: false,
      NEW_OPERATION: false,
      LIFECYCLE: true,
    },
  ],
  [
    'suspension FULL + exception',
    { operationalStatus: 'SUSPENDED', suspensionScope: 'FULL' },
    true,
    {
      CLINIC_INFO: true,
      READ: true,
      CONTINUITY_OF_CARE: true,
      ADMINISTRATION: false,
      NEW_OPERATION: false,
      LIFECYCLE: true,
    },
  ],
  [
    'CLOSING',
    { operationalStatus: 'CLOSING' },
    false,
    {
      CLINIC_INFO: true,
      READ: true,
      CONTINUITY_OF_CARE: true,
      ADMINISTRATION: true,
      NEW_OPERATION: false,
      LIFECYCLE: true,
    },
  ],
  [
    'CLOSING + FULL suspension',
    { operationalStatus: 'CLOSING', suspensionScope: 'FULL' },
    false,
    {
      CLINIC_INFO: true,
      READ: false,
      CONTINUITY_OF_CARE: false,
      ADMINISTRATION: false,
      NEW_OPERATION: false,
      LIFECYCLE: true,
    },
  ],
  [
    'CLOSED',
    { operationalStatus: 'CLOSED' },
    true,
    {
      CLINIC_INFO: true,
      READ: true,
      CONTINUITY_OF_CARE: false,
      ADMINISTRATION: false,
      NEW_OPERATION: false,
      LIFECYCLE: false,
    },
  ],
  [
    'subscription restricted',
    { subscription: badSub },
    false,
    {
      CLINIC_INFO: true,
      READ: true,
      CONTINUITY_OF_CARE: true,
      ADMINISTRATION: true,
      NEW_OPERATION: false,
      LIFECYCLE: true,
    },
  ],
  [
    'branch INACTIVE',
    { branchStatus: 'INACTIVE' },
    false,
    {
      CLINIC_INFO: true,
      READ: true,
      CONTINUITY_OF_CARE: true,
      ADMINISTRATION: true,
      NEW_OPERATION: false,
      LIFECYCLE: true,
    },
  ],
];

describe('evaluateClinicOperation (operating policy matrix)', () => {
  for (const [name, patch, exception, expected] of MATRIX) {
    it.each(CATEGORIES)(`${name}: %s`, (category) => {
      expect(evaluateClinicOperation({ ...base, ...patch }, category, exception).allowed).toBe(
        expected[category],
      );
    });
  }

  it('returns specific, stable error codes', () => {
    const code = (patch: Partial<ClinicOperatingState>, c: OperationCategory) => {
      const d = evaluateClinicOperation({ ...base, ...patch }, c, false);
      return d.allowed ? null : d.code;
    };
    expect(code({ operationalStatus: 'CLOSED' }, 'ADMINISTRATION')).toBe('CLINIC_CLOSED');
    expect(code({ suspensionScope: 'FULL', operationalStatus: 'SUSPENDED' }, 'READ')).toBe(
      'CLINIC_SUSPENDED',
    );
    expect(code({ operationalStatus: 'CLOSING' }, 'NEW_OPERATION')).toBe('CLINIC_CLOSING');
    expect(code({ subscription: badSub }, 'NEW_OPERATION')).toBe('SUBSCRIPTION_INACTIVE');
    expect(code({ branchStatus: 'INACTIVE' }, 'NEW_OPERATION')).toBe('BRANCH_INACTIVE');
  });

  it('an access exception never unlocks administration or new operations', () => {
    const full = {
      ...base,
      operationalStatus: 'SUSPENDED' as const,
      suspensionScope: 'FULL' as const,
    };
    expect(evaluateClinicOperation(full, 'ADMINISTRATION', true).allowed).toBe(false);
    expect(evaluateClinicOperation(full, 'NEW_OPERATION', true).allowed).toBe(false);
  });
});

describe('CLINIC_LIFECYCLE', () => {
  it('allows only the defined operational transitions; CLOSED is final', () => {
    expect(CLINIC_LIFECYCLE.can('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(CLINIC_LIFECYCLE.can('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(CLINIC_LIFECYCLE.can('ACTIVE', 'CLOSING')).toBe(true);
    expect(CLINIC_LIFECYCLE.can('CLOSING', 'CLOSED')).toBe(true);
    expect(CLINIC_LIFECYCLE.can('ACTIVE', 'CLOSED')).toBe(false);
    expect(CLINIC_LIFECYCLE.can('CLOSING', 'ACTIVE')).toBe(false);
    for (const to of ['ACTIVE', 'SUSPENDED', 'CLOSING'] as const)
      expect(CLINIC_LIFECYCLE.can('CLOSED', to)).toBe(false);
    expect(() => {
      CLINIC_LIFECYCLE.assert('CLOSED', 'ACTIVE');
    }).toThrow(/cannot change/);
  });
});
