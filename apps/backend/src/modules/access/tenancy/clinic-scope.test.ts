import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '../../../infrastructure/database/database.js';
import { ClinicScope, tenantExecutor, TenantScopeViolationError } from './clinic-scope.js';
import { createVerifiedClinicScope } from './clinic-scope-factory.js';

function fakeExecutor() {
  const query = vi.fn(() => Promise.resolve([]));
  const execute = vi.fn(() => Promise.resolve({ affectedRows: 0 }));
  return { executor: { query, execute } as unknown as SqlExecutor, query, execute };
}

describe('ClinicScope', () => {
  it('cannot be constructed directly and is immutable', () => {
    const scope = createVerifiedClinicScope('5', null);
    expect(scope).toBeInstanceOf(ClinicScope);
    expect(Object.isFrozen(scope)).toBe(true);
  });
});

describe('tenantExecutor', () => {
  const scope = createVerifiedClinicScope('5', null);

  it('passes statements that filter by the scope clinic', async () => {
    const { executor, query, execute } = fakeExecutor();
    const db = tenantExecutor(executor, scope);
    await db.query('SELECT * FROM t WHERE id = ? AND clinic_id = ?', ['1', '5']);
    await db.execute('INSERT INTO t (clinic_id, name) VALUES (?, ?)', ['5', 'x']);
    expect(query).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects statements without a clinic filter', async () => {
    const db = tenantExecutor(fakeExecutor().executor, scope);
    await expect(
      Promise.resolve().then(() => db.query('SELECT * FROM t WHERE id = ?', ['1'])),
    ).rejects.toThrow(TenantScopeViolationError);
    await expect(
      Promise.resolve().then(() => db.execute('DELETE FROM t WHERE id = ?', ['1'])),
    ).rejects.toThrow(TenantScopeViolationError);
    await expect(
      Promise.resolve().then(() => db.execute('INSERT INTO t (name) VALUES (?)', ['5'])),
    ).rejects.toThrow(TenantScopeViolationError);
  });

  it('rejects statements bound to another clinic id', async () => {
    const db = tenantExecutor(fakeExecutor().executor, scope);
    await expect(
      Promise.resolve().then(() => db.query('SELECT * FROM t WHERE clinic_id = ?', ['6'])),
    ).rejects.toThrow(/does not bind/);
  });
});
