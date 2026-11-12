/** Access module public API: authorization, permission catalog, tenant (clinic) context. */
export {
  ASSIGNABLE_CLINIC_ROLES,
  CLINIC_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  isClinicRole,
  isPermission,
  permissionCategory,
  permissionLevel,
  permissionScope,
  type OperationCategory,
  type ClinicRole,
  type Permission,
  type Role,
} from './authorization/catalog.js';
export {
  AuthorizationService,
  denyError,
  type ClinicOperationGate,
  type Decision,
  type Principal,
} from './authorization/authorization.service.js';
export { evaluateClinicPermission } from './authorization/evaluate.js';
export { ClinicScope, tenantExecutor, TenantScopeViolationError } from './tenancy/clinic-scope.js';
export {
  BRANCH_HEADER,
  BranchAccessDeniedError,
  CLINIC_HEADER,
  clinicContext,
  requireTenant,
  TenantContextResolver,
  type TenantContext,
} from './tenancy/tenant-context.js';
export {
  MembershipsRepository,
  isPeriodEnded,
  membershipPeriod,
  type ActiveMembership,
  type BranchScope,
  type MembershipStatus,
} from './tenancy/memberships.repository.js';
export {
  MEMBERSHIP_LIFECYCLE,
  MembershipService,
  type MembershipPolicyHooks,
} from './tenancy/membership.service.js';
export { requirePermission } from './http/require-permission.js';
export { principalOf } from './http/principal.js';
export { createAccessRouter } from './http/access.routes.js';
