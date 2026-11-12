import type { SqlExecutor } from '../../infrastructure/database/database.js';
import { tenantExecutor, type ClinicScope } from '../access/index.js';
import { addressFromRow, type Address } from './clinics.repository.js';

export interface Branch extends Address {
  readonly id: string;
  readonly clinicId: string;
  readonly name: string;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly timeZone: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly settings: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type Row = Record<string, unknown>;

const toBranch = (r: Row): Branch => ({
  id: String(r.id),
  clinicId: String(r.clinic_id),
  name: r.name as string,
  ...addressFromRow(r),
  contactPhone: (r.contact_phone as string | null) ?? null,
  contactEmail: (r.contact_email as string | null) ?? null,
  timeZone: r.time_zone as string,
  status: r.status as 'ACTIVE' | 'INACTIVE',
  settings: r.settings ?? null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

/** Tenant-scoped (ClinicScope + tenantExecutor) — see TENANT_ISOLATION.md. */
export class BranchesRepository {
  async list(
    executor: SqlExecutor,
    scope: ClinicScope,
    restrictTo: readonly string[] | 'ALL',
  ): Promise<Branch[]> {
    if (restrictTo !== 'ALL' && restrictTo.length === 0) return [];
    const filter =
      restrictTo === 'ALL' ? '' : ` AND id IN (${restrictTo.map(() => '?').join(', ')})`;
    const rows = await tenantExecutor(executor, scope).query<Row>(
      `SELECT * FROM clinic_branches WHERE clinic_id = ?${filter} ORDER BY name, id`,
      [scope.clinicId, ...(restrictTo === 'ALL' ? [] : restrictTo)],
    );
    return rows.map(toBranch);
  }

  async find(
    executor: SqlExecutor,
    scope: ClinicScope,
    branchId: string,
    forUpdate = false,
  ): Promise<Branch | undefined> {
    const rows = await tenantExecutor(executor, scope).query<Row>(
      `SELECT * FROM clinic_branches WHERE id = ? AND clinic_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
      [branchId, scope.clinicId],
    );
    return rows[0] === undefined ? undefined : toBranch(rows[0]);
  }

  async insert(
    executor: SqlExecutor,
    scope: ClinicScope,
    columns: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<string> {
    const entries = Object.entries(columns);
    const result = await tenantExecutor(executor, scope).execute(
      `INSERT INTO clinic_branches (clinic_id, ${entries.map(([c]) => c).join(', ')}) VALUES (?, ${entries.map(() => '?').join(', ')})`,
      [scope.clinicId, ...entries.map(([, v]) => v)],
    );
    return String(result.insertId);
  }

  async update(
    executor: SqlExecutor,
    scope: ClinicScope,
    branchId: string,
    columns: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<boolean> {
    const entries = Object.entries(columns);
    if (entries.length === 0) return true;
    const result = await tenantExecutor(executor, scope).execute(
      `UPDATE clinic_branches SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ? AND clinic_id = ?`,
      [...entries.map(([, v]) => v), branchId, scope.clinicId],
    );
    return result.affectedRows === 1;
  }

  /** Platform path: first branch created inside the registration-approval transaction. */
  async insertInitial(
    executor: SqlExecutor,
    clinicId: string,
    columns: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<string> {
    const entries = Object.entries(columns);
    const result = await executor.execute(
      `INSERT INTO clinic_branches (clinic_id, ${entries.map(([c]) => c).join(', ')}) VALUES (?, ${entries.map(() => '?').join(', ')})`,
      [clinicId, ...entries.map(([, v]) => v)],
    );
    return String(result.insertId);
  }

  /** Platform path (Super Admin views). */
  async listForPlatform(executor: SqlExecutor, clinicId: string): Promise<Branch[]> {
    return (
      await executor.query<Row>('SELECT * FROM clinic_branches WHERE clinic_id = ? ORDER BY id', [
        clinicId,
      ])
    ).map(toBranch);
  }
}
