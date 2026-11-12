import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Database } from '../../../infrastructure/database/database.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { Clock } from '../../../shared/security/clock.js';
import { requireAuth } from '../../iam/index.js';
import type { ClinicScope } from './clinic-scope.js';
import { createVerifiedClinicScope } from './clinic-scope-factory.js';
import type { ActiveMembership, MembershipsRepository } from './memberships.repository.js';

export const CLINIC_HEADER = 'x-clinic-id';
export const BRANCH_HEADER = 'x-branch-id';
const ID_PATTERN = /^[1-9]\d{0,19}$/;

/** Validated clinic (and optional branch) context of ONE request. */
export interface TenantContext {
  readonly clinicId: string;
  readonly branchId: string | null;
  readonly scope: ClinicScope;
  readonly memberships: readonly ActiveMembership[];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `clinicContext`. Request-scoped: never shared between requests. */
    tenant?: TenantContext;
  }
}

export class ClinicAccessDeniedError extends AppError {
  constructor() {
    // Same response whether the clinic does not exist or the caller is not a member.
    super(403, 'CLINIC_ACCESS_DENIED', 'You do not have access to this clinic');
  }
}

export class BranchAccessDeniedError extends AppError {
  constructor() {
    super(403, 'BRANCH_ACCESS_DENIED', 'You do not have access to this branch');
  }
}

export class ClinicContextRequiredError extends AppError {
  constructor() {
    super(400, 'CLINIC_CONTEXT_REQUIRED', 'Select a clinic (X-Clinic-Id) for this operation');
  }
}

/**
 * Resolves clinic context from untrusted input. The clinic id is only accepted after verifying
 * an active, in-window membership of the user in that clinic, read from MySQL now.
 */
export class TenantContextResolver {
  constructor(
    private readonly db: Database,
    private readonly memberships: MembershipsRepository,
    private readonly clock: Clock,
  ) {}

  async resolve(
    userId: string,
    clinicIdInput: string,
    branchIdInput: string | null,
  ): Promise<TenantContext> {
    if (!ID_PATTERN.test(clinicIdInput)) {
      throw new AppError(400, 'INVALID_CLINIC_CONTEXT', 'Invalid clinic id');
    }
    if (branchIdInput !== null && !ID_PATTERN.test(branchIdInput)) {
      throw new AppError(400, 'INVALID_BRANCH_CONTEXT', 'Invalid branch id');
    }
    const memberships = await this.memberships.findActive(
      this.db,
      userId,
      clinicIdInput,
      this.clock(),
    );
    if (memberships.length === 0) throw new ClinicAccessDeniedError();

    if (branchIdInput !== null) {
      const covered = memberships.some(
        (m) => m.branchScope === 'ALL' || m.branchIds.includes(branchIdInput),
      );
      // The existence check also stops "ALL" members from naming a branch of another clinic.
      if (
        !covered ||
        !(await this.memberships.branchExists(this.db, clinicIdInput, branchIdInput))
      ) {
        throw new BranchAccessDeniedError();
      }
    }
    return {
      clinicId: clinicIdInput,
      branchId: branchIdInput,
      scope: createVerifiedClinicScope(clinicIdInput, branchIdInput),
      memberships,
    };
  }
}

/**
 * Middleware establishing req.tenant. Source of the clinic id, in order: the `X-Clinic-Id`
 * header, then the clinic remembered on the session (POST /context/clinic). Clinic ids in
 * bodies, query strings or paths are never used as context.
 *
 * `required: true` (default) rejects requests without a clinic → fail safe for scoped routes.
 */
export function clinicContext(
  resolver: TenantContextResolver,
  options: { required?: boolean } = {},
): RequestHandler {
  const required = options.required ?? true;
  return async (req: Request, _res: Response, next: NextFunction) => {
    const auth = requireAuth(req);
    const clinicId = req.get(CLINIC_HEADER) ?? auth.activeClinicId ?? null;
    if (clinicId === null) {
      if (required) throw new ClinicContextRequiredError();
      next();
      return;
    }
    req.tenant = await resolver.resolve(
      auth.userId,
      clinicId.trim(),
      req.get(BRANCH_HEADER)?.trim() ?? null,
    );
    next();
  };
}

export function requireTenant(req: Request): TenantContext {
  if (req.tenant === undefined) throw new ClinicContextRequiredError();
  return req.tenant;
}
