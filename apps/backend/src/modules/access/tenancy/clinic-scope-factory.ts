import { constructClinicScope, type ClinicScope } from './clinic-scope.js';

/**
 * Creates a ClinicScope. Call ONLY after verifying an active membership (tenant-context.ts) or
 * in tests. ESLint (`no-restricted-imports`) blocks importing this file from anywhere else.
 */
export function createVerifiedClinicScope(clinicId: string, branchId: string | null): ClinicScope {
  return constructClinicScope(clinicId, branchId);
}
