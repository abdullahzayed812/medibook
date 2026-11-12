import type { Database } from '../../../infrastructure/database/database.js';
import { AppError, ForbiddenError, NotFoundError } from '../../../shared/errors/app-error.js';
import type { ClinicScope } from '../tenancy/clinic-scope.js';
import { ClinicContextRequiredError, type TenantContext } from '../tenancy/tenant-context.js';
import {
  PERMISSIONS,
  permissionCategory,
  permissionScope,
  type OperationCategory,
  type Permission,
  type Scope,
} from './catalog.js';
import { evaluateClinicPermission } from './evaluate.js';

export interface Principal {
  readonly userId: string;
  readonly mfaVerified: boolean;
}

export interface AuthorizationContext {
  /** Required for CLINIC permissions; obtained from the clinicContext middleware only. */
  readonly tenant?: TenantContext | undefined;
}

/**
 * Clinic state enforcement hook (lifecycle, suspension, closure, subscription). Implemented by
 * the clinics module and injected here so every clinic permission check also honours the
 * clinic's operating state, without the access module depending on clinic management.
 */
export interface ClinicOperationGate {
  evaluate(input: {
    clinicId: string;
    branchId: string | null;
    userId: string;
    category: OperationCategory;
  }): Promise<{ allowed: true } | { allowed: false; code: string; message: string }>;
}

export type DenyReason =
  | 'CLINIC_RESTRICTED'
  | 'NO_PERMISSION'
  | 'CLINIC_CONTEXT_REQUIRED'
  | 'BRANCH_CONTEXT_REQUIRED'
  | 'MFA_REQUIRED'
  | 'MFA_ENROLLMENT_REQUIRED';

export type Decision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: DenyReason;
      /** Set when reason = CLINIC_RESTRICTED (e.g. CLINIC_SUSPENDED, SUBSCRIPTION_INACTIVE). */
      readonly restriction?: { readonly code: string; readonly message: string };
    };

const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * The single place where authorization decisions are made. Controllers and services ask it;
 * they never inspect roles themselves.
 *
 * Every decision reads current state from MySQL (global roles, memberships via TenantContext,
 * role_permissions), so revocations and mapping changes apply to the very next request.
 *
 * - PLATFORM permissions: from global roles; additionally require an MFA-verified session.
 * - PATIENT permissions: from the global PATIENT role; target resources need ownership checks.
 * - CLINIC permissions: only inside a verified TenantContext; never carried across clinics.
 */
export class AuthorizationService {
  constructor(
    private readonly db: Database,
    private readonly gate?: ClinicOperationGate,
  ) {}

  async check(
    principal: Principal,
    permission: Permission,
    context: AuthorizationContext = {},
  ): Promise<Decision> {
    const scope = permissionScope(permission);
    if (scope === 'CLINIC') {
      if (context.tenant === undefined)
        return { allowed: false, reason: 'CLINIC_CONTEXT_REQUIRED' };
      const decision = evaluateClinicPermission({
        memberships: context.tenant.memberships,
        rolePermissions: await this.rolePermissions(context.tenant.memberships.map((m) => m.role)),
        permission,
        branchId: context.tenant.branchId,
      });
      if (!decision.allowed || this.gate === undefined) return decision;
      const gate = await this.gate.evaluate({
        clinicId: context.tenant.clinicId,
        branchId: context.tenant.branchId,
        userId: principal.userId,
        category: permissionCategory(permission),
      });
      return gate.allowed
        ? gate
        : {
            allowed: false,
            reason: 'CLINIC_RESTRICTED',
            restriction: { code: gate.code, message: gate.message },
          };
    }

    const granted = await this.globalPermissions(principal.userId, scope);
    if (!granted.includes(permission)) return { allowed: false, reason: 'NO_PERMISSION' };
    if (scope === 'PLATFORM' && !principal.mfaVerified) {
      return {
        allowed: false,
        reason: (await this.isMfaEnrolled(principal.userId))
          ? 'MFA_REQUIRED'
          : 'MFA_ENROLLMENT_REQUIRED',
      };
    }
    return { allowed: true };
  }

  /** Throws the HTTP error matching the decision. */
  async assert(
    principal: Principal,
    permission: Permission,
    context: AuthorizationContext = {},
  ): Promise<void> {
    const decision = await this.check(principal, permission, context);
    if (!decision.allowed) {
      throw decision.restriction === undefined
        ? denyError(decision.reason)
        : new AppError(403, decision.restriction.code, decision.restriction.message);
    }
  }

  /** Permissions granted by global roles of `scope` (PLATFORM or PATIENT), ignoring MFA state. */
  async globalPermissions(userId: string, scope: Exclude<Scope, 'CLINIC'>): Promise<Permission[]> {
    const rows = await this.db.query<{ permission_code: string }>(
      `SELECT DISTINCT rp.permission_code
         FROM user_global_roles ugr
         JOIN role_permissions rp ON rp.role_code = ugr.role_code
        WHERE ugr.user_id = ? AND rp.permission_scope = ?
        ORDER BY rp.permission_code`,
      [userId, scope],
    );
    return rows.map((row) => row.permission_code).filter(isKnownPermission);
  }

  /** Every clinic permission the tenant context currently grants (for UIs; not for checks). */
  async clinicPermissions(tenant: TenantContext): Promise<Permission[]> {
    const rolePermissions = await this.rolePermissions(tenant.memberships.map((m) => m.role));
    return ALL_PERMISSIONS.toSorted().filter(
      (permission) =>
        permissionScope(permission) === 'CLINIC' &&
        evaluateClinicPermission({
          memberships: tenant.memberships,
          rolePermissions,
          permission,
          branchId: tenant.branchId,
        }).allowed,
    );
  }

  async isMfaEnrolled(userId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM mfa_totp_credentials WHERE user_id = ? AND status = 'ACTIVE'`,
      [userId],
    );
    return rows.length > 0;
  }

  async rolePermissions(roles: readonly string[]): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const unique = [...new Set(roles)];
    if (unique.length === 0) return map;
    const rows = await this.db.query<{ role_code: string; permission_code: string }>(
      `SELECT role_code, permission_code FROM role_permissions
        WHERE role_code IN (${unique.map(() => '?').join(', ')})`,
      unique,
    );
    for (const row of rows) {
      const set = map.get(row.role_code) ?? new Set<string>();
      set.add(row.permission_code);
      map.set(row.role_code, set);
    }
    return map;
  }

  /**
   * Ownership check for user-owned resources (e.g. a patient's own profile/bookings).
   * A mismatch is reported as 404 so resource ids of other users are not confirmed to exist.
   */
  assertOwner(principal: Principal, ownerUserId: string | null): void {
    if (ownerUserId === null || ownerUserId !== principal.userId) throw new NotFoundError();
  }

  /** Defence in depth for loaded clinic-scoped resources: must belong to the scope's clinic. */
  assertInScope(scope: ClinicScope, resourceClinicId: string): void {
    if (resourceClinicId !== scope.clinicId) throw new NotFoundError();
  }
}

function isKnownPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

export function denyError(reason: DenyReason): AppError {
  switch (reason) {
    case 'CLINIC_RESTRICTED':
      return new AppError(
        403,
        'CLINIC_RESTRICTED',
        'This operation is not available for the clinic right now',
      );
    case 'NO_PERMISSION':
      return new ForbiddenError('You do not have permission to perform this action');
    case 'CLINIC_CONTEXT_REQUIRED':
      return new ClinicContextRequiredError();
    case 'BRANCH_CONTEXT_REQUIRED':
      return new AppError(
        400,
        'BRANCH_CONTEXT_REQUIRED',
        'Select a branch (X-Branch-Id) for this operation',
      );
    case 'MFA_REQUIRED':
      return new AppError(
        403,
        'MFA_REQUIRED',
        'Two-factor verification is required for this action',
      );
    case 'MFA_ENROLLMENT_REQUIRED':
      return new AppError(
        403,
        'MFA_ENROLLMENT_REQUIRED',
        'Two-factor authentication must be enabled first',
      );
  }
}
