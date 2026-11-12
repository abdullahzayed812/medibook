import type { ActiveMembership } from '../tenancy/memberships.repository.js';
import { permissionLevel, type Permission } from './catalog.js';

export type ClinicDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'NO_PERMISSION' | 'BRANCH_CONTEXT_REQUIRED' };

/**
 * Pure clinic-permission rule (unit-tested exhaustively).
 *
 * A permission is granted by an active membership whose role has it AND whose branch coverage
 * fits the request:
 *   - MEMBER-level permission → any holding membership (clinic-wide, non-branch information);
 *   - CLINIC-level permission → membership must cover ALL branches;
 *   - BRANCH-level permission → ALL branches, or the selected branch is assigned. Without a
 *     selected branch, branch-assigned members are refused (fail safe), so they can never act
 *     on data of branches they are not assigned to.
 */
export function evaluateClinicPermission(input: {
  memberships: readonly ActiveMembership[];
  rolePermissions: ReadonlyMap<string, ReadonlySet<string>>;
  permission: Permission;
  branchId: string | null;
}): ClinicDecision {
  const holders = input.memberships.filter(
    (m) => input.rolePermissions.get(m.role)?.has(input.permission) === true,
  );
  if (holders.length === 0) return { allowed: false, reason: 'NO_PERMISSION' };
  if (holders.some((m) => m.branchScope === 'ALL')) return { allowed: true };
  // MEMBER level: clinic-wide information any member whose role holds it may see.
  if (permissionLevel(input.permission) === 'MEMBER') return { allowed: true };

  if (permissionLevel(input.permission) === 'CLINIC')
    return { allowed: false, reason: 'NO_PERMISSION' };
  if (input.branchId === null) return { allowed: false, reason: 'BRANCH_CONTEXT_REQUIRED' };
  const branchId = input.branchId;
  return holders.some((m) => m.branchIds.includes(branchId))
    ? { allowed: true }
    : { allowed: false, reason: 'NO_PERMISSION' };
}
