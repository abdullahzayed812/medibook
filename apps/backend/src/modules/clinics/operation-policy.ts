import { defineStateMachine } from '../../shared/state-machine.js';
import type { OperationCategory } from '../access/index.js';
import type { EffectiveSubscription } from '../subscriptions/policy.js';

export const OPERATIONAL_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSING', 'CLOSED'] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];
export type SuspensionScope = 'FULL' | 'NEW_OPERATIONS';

/** Clinic operational lifecycle. CLOSED is final (records are retained, never deleted). */
export const CLINIC_LIFECYCLE = defineStateMachine<OperationalStatus>('Clinic', {
  ACTIVE: ['SUSPENDED', 'CLOSING'],
  SUSPENDED: ['ACTIVE', 'CLOSING'],
  CLOSING: ['CLOSED'],
  CLOSED: [],
});

export interface ClinicOperatingState {
  readonly operationalStatus: OperationalStatus;
  /** Scope of the open suspension, if any (can coexist with CLOSING). */
  readonly suspensionScope: SuspensionScope | null;
  readonly subscription: EffectiveSubscription;
  /** Status of the selected branch (null when no branch is selected). */
  readonly branchStatus: 'ACTIVE' | 'INACTIVE' | null;
}

export type OperationDecision =
  { allowed: true } | { allowed: false; code: string; message: string };

const deny = (code: string, message: string): OperationDecision => ({
  allowed: false,
  code,
  message,
});

/**
 * THE operating policy (single source of truth, unit-tested as a matrix):
 *
 * | state                         | CLINIC_INFO | READ | CONTINUITY | ADMIN | NEW_OP | LIFECYCLE |
 * |-------------------------------|:-:|:-:|:-:|:-:|:-:|:-:|
 * | ACTIVE                        | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
 * | suspension NEW_OPERATIONS     | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
 * | suspension FULL               | ✅ | exception | exception | ❌ | ❌ | ✅ |
 * | CLOSING                       | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
 * | CLOSED                        | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
 * | subscription restricted       | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
 * | selected branch INACTIVE      | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
 *
 * "exception" = only users holding an explicit, unexpired, Super-Admin-granted access exception
 * (continuity of care). Rules combine: the most restrictive applies.
 */
export function evaluateClinicOperation(
  state: ClinicOperatingState,
  category: OperationCategory,
  hasAccessException: boolean,
): OperationDecision {
  if (category === 'CLINIC_INFO') return { allowed: true };

  if (state.operationalStatus === 'CLOSED') {
    return category === 'READ'
      ? { allowed: true }
      : deny('CLINIC_CLOSED', 'The clinic is closed; only existing records can be viewed');
  }

  if (state.suspensionScope === 'FULL') {
    if (category === 'LIFECYCLE') return { allowed: true };
    if ((category === 'READ' || category === 'CONTINUITY_OF_CARE') && hasAccessException) {
      return { allowed: true };
    }
    return deny('CLINIC_SUSPENDED', 'The clinic is suspended');
  }

  if (category !== 'NEW_OPERATION') return { allowed: true };

  if (state.suspensionScope === 'NEW_OPERATIONS') {
    return deny('CLINIC_SUSPENDED', 'The clinic is suspended for new operations');
  }
  if (state.operationalStatus === 'CLOSING') {
    return deny('CLINIC_CLOSING', 'The clinic is closing; new operations are not accepted');
  }
  if (!state.subscription.permitsNewOperations) {
    return deny('SUBSCRIPTION_INACTIVE', 'The clinic subscription does not allow new operations');
  }
  if (state.branchStatus === 'INACTIVE') {
    return deny('BRANCH_INACTIVE', 'The selected branch is inactive');
  }
  return { allowed: true };
}

/** Categories that, under a FULL suspension, an access exception can unlock. */
export const EXCEPTION_CATEGORIES: readonly OperationCategory[] = ['READ', 'CONTINUITY_OF_CARE'];
