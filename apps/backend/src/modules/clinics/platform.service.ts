import type { Database } from '../../infrastructure/database/database.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { AuthorizationService, Principal } from '../access/index.js';
import type { SubscriptionService } from '../subscriptions/index.js';
import type { BranchesRepository } from './branches.repository.js';
import type { ClinicsRepository } from './clinics.repository.js';
import type { OperationalStatus } from './operation-policy.js';

/** Super Admin read views across clinics (explicit platform permission; no tenant context). */
export class ClinicPlatformService {
  constructor(
    private readonly db: Database,
    private readonly clinics: ClinicsRepository,
    private readonly branches: BranchesRepository,
    private readonly subscriptions: SubscriptionService,
    private readonly authz: AuthorizationService,
  ) {}

  async list(
    actor: Principal,
    filter: {
      operationalStatus?: OperationalStatus | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    await this.authz.assert(actor, 'platform.clinics.view');
    return toPage(await this.clinics.list(this.db, filter), filter.limit);
  }

  async detail(actor: Principal, clinicId: string) {
    await this.authz.assert(actor, 'platform.clinics.view');
    const clinic = await this.clinics.find(this.db, clinicId);
    if (clinic === undefined) throw new NotFoundError('Clinic not found');
    return {
      clinic,
      branches: await this.branches.listForPlatform(this.db, clinicId),
      suspension: (await this.clinics.openSuspension(this.db, clinicId)) ?? null,
      lifecycleHistory: await this.clinics.listHistory(this.db, clinicId),
      subscription: await this.subscriptions.view(clinicId),
    };
  }
}
