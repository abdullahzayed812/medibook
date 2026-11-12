import type { SqlExecutor, SqlParams } from '../../../infrastructure/database/database.js';

let construct: ((clinicId: string, branchId: string | null) => ClinicScope) | undefined;

/**
 * Proof that the current caller was verified to have an active membership in `clinicId`
 * (and, if set, access to `branchId`). It cannot be constructed with `new`; it is created only
 * by the tenant-context resolver after the membership check (see clinic-scope-factory.ts, whose
 * import is restricted by ESLint).
 *
 * Every repository method on a clinic-scoped table takes a ClinicScope as its first argument
 * and must filter by `scope.clinicId`. There is deliberately no way to pass a raw clinic id.
 */
export class ClinicScope {
  static {
    construct = (clinicId, branchId) => new ClinicScope(clinicId, branchId);
  }

  private constructor(
    readonly clinicId: string,
    readonly branchId: string | null,
  ) {
    Object.freeze(this);
  }
}

/** @internal Used by clinic-scope-factory.ts only. */
export function constructClinicScope(clinicId: string, branchId: string | null): ClinicScope {
  if (construct === undefined) throw new Error('ClinicScope not initialised');
  return construct(clinicId, branchId);
}

export class TenantScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeViolationError';
  }
}

const CLINIC_FILTER = /\bclinic_id\s*=\s*\?/i;
const INSERT_STATEMENT = /^\s*INSERT\b/i;
const INSERT_WITH_CLINIC_COLUMN = /^\s*INSERT\s+INTO\s+\w+\s*\([^)]*\bclinic_id\b[^)]*\)/i;

/**
 * Guard rail for clinic-scoped repositories: wraps an executor so that every statement must
 * contain a `clinic_id = ?` predicate (INSERTs: a `clinic_id` column) AND bind the scope's
 * clinic id. An accidental unscoped
 * query (missing filter, or filtered by some other clinic id) fails loudly instead of leaking
 * data. This is a safety net, not a substitute for writing the WHERE clause correctly.
 */
export function tenantExecutor(executor: SqlExecutor, scope: ClinicScope): SqlExecutor {
  const check = (sql: string, params: SqlParams): void => {
    const scoped = INSERT_STATEMENT.test(sql)
      ? INSERT_WITH_CLINIC_COLUMN.test(sql)
      : CLINIC_FILTER.test(sql);
    if (!scoped) {
      throw new TenantScopeViolationError(
        'Clinic-scoped statement is missing a `clinic_id = ?` filter',
      );
    }
    if (!params.some((param) => String(param) === scope.clinicId)) {
      throw new TenantScopeViolationError(
        'Clinic-scoped statement does not bind the scope clinic id',
      );
    }
  };
  return {
    query: (sql, params = []) => {
      check(sql, params);
      return executor.query(sql, params);
    },
    execute: (sql, params = []) => {
      check(sql, params);
      return executor.execute(sql, params);
    },
  };
}
