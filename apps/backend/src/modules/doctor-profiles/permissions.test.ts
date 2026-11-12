import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../infrastructure/database/database.js';
import { ForbiddenError } from '../../shared/errors/app-error.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { AuthorizationService, Permission } from '../access/index.js';
import { ROLE_PERMISSIONS } from '../access/authorization/catalog.js';
import type { AuditLog } from '../audit/index.js';
import type { PrivateDocuments } from '../platform/index.js';
import { DoctorProfileService, SpecialtyService } from './doctor-profiles.service.js';

/**
 * Task 03.1: the specialty catalog and doctor verification are guarded by separate permissions.
 * The fakes grant exactly one permission set and record every write, so a denied call must
 * never reach the database.
 */
const actor = { userId: '1', mfaVerified: true };
const meta = { requestId: 'r', ip: null, userAgent: null } as unknown as RequestMeta;

function fakes(granted: readonly Permission[]) {
  const asked: string[] = [];
  const writes: string[] = [];
  const authz = {
    assert: vi.fn((_principal: unknown, permission: Permission) => {
      asked.push(permission);
      return granted.includes(permission)
        ? Promise.resolve()
        : Promise.reject(new ForbiddenError('You do not have permission to perform this action'));
    }),
  } as unknown as AuthorizationService;
  const tx = {
    execute: vi.fn((sql: string) => {
      writes.push(sql);
      return Promise.resolve({ affectedRows: 1, insertId: 0 });
    }),
    query: vi.fn(() => Promise.resolve([])),
  };
  const db = {
    ...tx,
    transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as Database;
  const auditLog = {
    record: vi.fn(() => {
      writes.push('audit');
      return Promise.resolve();
    }),
  } as unknown as AuditLog;
  const specialties = new SpecialtyService(db, authz, auditLog);
  const doctors = new DoctorProfileService({
    db,
    authz,
    auditLog,
    documents: {} as PrivateDocuments,
    clock: () => new Date(),
  });
  return { asked, writes, specialties, doctors };
}

const upsert = { code: 'cardiology', name: 'Cardiology' };

describe('specialty catalog permission', () => {
  it('is granted to SUPER_ADMIN only, alongside (not instead of) doctor verification', () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).toContain('platform.specialties.manage');
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).toContain('platform.doctors.verify');
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === 'SUPER_ADMIN') continue;
      expect(permissions, role).not.toContain('platform.specialties.manage');
    }
  });

  it('allows create, rename and deactivate with platform.specialties.manage', async () => {
    const f = fakes(['platform.specialties.manage']);
    await f.specialties.upsert(actor, upsert, meta);
    await f.specialties.upsert(actor, { ...upsert, name: 'Cardiology (Adult)' }, meta);
    await f.specialties.upsert(actor, { ...upsert, active: false }, meta);
    expect(f.asked).toEqual(Array(3).fill('platform.specialties.manage'));
    expect(f.writes.filter((w) => w === 'audit')).toHaveLength(3);
  });

  it('denies every catalog change to a holder of only platform.doctors.verify, without writing', async () => {
    const f = fakes(['platform.doctors.verify']);
    for (const input of [upsert, { ...upsert, name: 'Renamed' }, { ...upsert, active: false }])
      await expect(f.specialties.upsert(actor, input, meta)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
    expect(f.asked).toEqual(Array(3).fill('platform.specialties.manage'));
    expect(f.writes).toEqual([]);
  });
});

describe('doctor verification permission', () => {
  it('allows review with platform.doctors.verify', async () => {
    const f = fakes(['platform.doctors.verify']);
    await expect(f.doctors.listForReview(actor, { limit: 10 })).resolves.toMatchObject({
      data: [],
    });
    expect(f.asked).toEqual(['platform.doctors.verify']);
  });

  it.each(['APPROVE', 'REJECT', 'SUSPEND', 'REINSTATE'] as const)(
    'denies %s to a holder of only platform.specialties.manage, without writing',
    async (decision) => {
      const f = fakes(['platform.specialties.manage']);
      await expect(f.doctors.decide(actor, '42', decision, 'reason', meta)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(f.asked).toEqual(['platform.doctors.verify']);
      expect(f.writes).toEqual([]);
    },
  );

  it('denies review listing and document access to a holder of only platform.specialties.manage', async () => {
    const f = fakes(['platform.specialties.manage']);
    await expect(f.doctors.listForReview(actor, { limit: 10 })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(f.doctors.getForReview(actor, '42')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.doctors.readDocumentForReview(actor, '42', '7', meta)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(f.writes).toEqual([]);
  });
});
