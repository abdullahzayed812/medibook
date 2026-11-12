import type { Database } from '../../infrastructure/database/database.js';
import type { Clock } from '../../shared/security/clock.js';
import type { ClinicOperationGate, OperationCategory } from '../access/index.js';
import type { SubscriptionService } from '../subscriptions/index.js';
import type { ClinicsRepository } from './clinics.repository.js';
import {
  EXCEPTION_CATEGORIES,
  evaluateClinicOperation,
  type ClinicOperatingState,
  type OperationDecision,
} from './operation-policy.js';

/**
 * Loads the clinic's current operating state from MySQL (no caching: suspensions, closures and
 * subscription changes apply to the next request) and evaluates the central policy.
 * Injected into AuthorizationService, so every clinic permission check passes through it.
 */
export class ClinicOperationGateImpl implements ClinicOperationGate {
  constructor(
    private readonly db: Database,
    private readonly clinics: ClinicsRepository,
    private readonly subscriptions: SubscriptionService,
    private readonly clock: Clock,
  ) {}

  async state(
    clinicId: string,
    branchId: string | null,
  ): Promise<ClinicOperatingState & { suspensionId: string | null }> {
    const clinic = await this.clinics.find(this.db, clinicId);
    if (clinic === undefined) throw new Error('Clinic disappeared during authorization');
    const suspension =
      clinic.operationalStatus === 'CLOSED'
        ? undefined
        : await this.clinics.openSuspension(this.db, clinicId);
    return {
      operationalStatus: clinic.operationalStatus,
      suspensionScope: suspension?.scope ?? null,
      suspensionId: suspension?.id ?? null,
      subscription: (await this.subscriptions.stateFor(this.db, clinicId)).effective,
      branchStatus:
        branchId === null ? null : await this.clinics.branchStatus(this.db, clinicId, branchId),
    };
  }

  async evaluate(input: {
    clinicId: string;
    branchId: string | null;
    userId: string;
    category: OperationCategory;
  }): Promise<OperationDecision> {
    if (input.category === 'CLINIC_INFO') return { allowed: true };
    const state = await this.state(input.clinicId, input.branchId);
    const exception =
      state.suspensionScope === 'FULL' &&
      state.suspensionId !== null &&
      EXCEPTION_CATEGORIES.includes(input.category)
        ? await this.clinics.hasActiveAccessException(
            this.db,
            input.clinicId,
            state.suspensionId,
            input.userId,
            this.clock(),
          )
        : false;
    return evaluateClinicOperation(state, input.category, exception);
  }
}
