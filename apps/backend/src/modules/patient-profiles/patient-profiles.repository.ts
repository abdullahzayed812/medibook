import type { SqlExecutor } from '../../infrastructure/database/database.js';
import { toPage, type Page } from '../../shared/http/pagination.js';
import { tenantExecutor, type ClinicScope } from '../access/index.js';

export interface PatientProfile {
  readonly id: string;
  readonly clinicId: string;
  readonly userId: string | null;
  readonly displayName: string;
  readonly createdAt: Date;
}

interface Row {
  id: string;
  clinic_id: string;
  user_id: string | null;
  display_name: string;
  created_at: Date;
}

const toProfile = (row: Row): PatientProfile => ({
  id: row.id,
  clinicId: row.clinic_id,
  userId: row.user_id,
  displayName: row.display_name,
  createdAt: row.created_at,
});

/**
 * Reference implementation of a TENANT-SCOPED repository (the pattern every clinic-scoped table
 * follows):
 *  - every method takes a ClinicScope first; there is no method taking a raw clinic id;
 *  - every statement filters by `clinic_id = ?` bound to scope.clinicId, including UPDATE and
 *    DELETE, so a manipulated id of another clinic matches zero rows (→ 404, never 403);
 *  - statements run through tenantExecutor(), which rejects SQL missing the clinic filter.
 * Patient business workflows are out of scope for Task 02; this exists for identity linkage
 * and tenant-isolation verification.
 */
export class PatientProfilesRepository {
  async create(
    executor: SqlExecutor,
    scope: ClinicScope,
    input: { displayName: string; userId?: string | null },
  ): Promise<string> {
    const db = tenantExecutor(executor, scope);
    const result = await db.execute(
      'INSERT INTO patient_profiles (clinic_id, user_id, display_name) VALUES (?, ?, ?)',
      [scope.clinicId, input.userId ?? null, input.displayName],
    );
    return String(result.insertId);
  }

  async findById(
    executor: SqlExecutor,
    scope: ClinicScope,
    id: string,
  ): Promise<PatientProfile | undefined> {
    const rows = await tenantExecutor(executor, scope).query<Row>(
      'SELECT id, clinic_id, user_id, display_name, created_at FROM patient_profiles WHERE id = ? AND clinic_id = ?',
      [id, scope.clinicId],
    );
    return rows[0] === undefined ? undefined : toProfile(rows[0]);
  }

  async list(
    executor: SqlExecutor,
    scope: ClinicScope,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<Page<PatientProfile>> {
    const rows = await tenantExecutor(executor, scope).query<Row>(
      `SELECT id, clinic_id, user_id, display_name, created_at FROM patient_profiles
        WHERE clinic_id = ? AND (? IS NULL OR id < ?)
        ORDER BY id DESC LIMIT ?`,
      [scope.clinicId, page.cursor ?? null, page.cursor ?? null, page.limit + 1],
    );
    return toPage(rows.map(toProfile), page.limit);
  }

  /** Returns false when no row of THIS clinic has the id. */
  async updateDisplayName(
    executor: SqlExecutor,
    scope: ClinicScope,
    id: string,
    displayName: string,
  ): Promise<boolean> {
    const result = await tenantExecutor(executor, scope).execute(
      'UPDATE patient_profiles SET display_name = ? WHERE id = ? AND clinic_id = ?',
      [displayName, id, scope.clinicId],
    );
    return result.affectedRows === 1;
  }

  async delete(executor: SqlExecutor, scope: ClinicScope, id: string): Promise<boolean> {
    const result = await tenantExecutor(executor, scope).execute(
      'DELETE FROM patient_profiles WHERE id = ? AND clinic_id = ?',
      [id, scope.clinicId],
    );
    return result.affectedRows === 1;
  }

  /** Patient self-service (ownership, not tenancy): a user's own profiles across clinics. */
  async listOwnedByUser(executor: SqlExecutor, userId: string): Promise<PatientProfile[]> {
    const rows = await executor.query<Row>(
      'SELECT id, clinic_id, user_id, display_name, created_at FROM patient_profiles WHERE user_id = ? ORDER BY id',
      [userId],
    );
    return rows.map(toProfile);
  }
}
