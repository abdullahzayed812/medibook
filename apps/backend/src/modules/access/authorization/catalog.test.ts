import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_CLINIC_ROLES,
  CLINIC_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  permissionScope,
  type Permission,
} from './catalog.js';

const CLINICAL: Permission[] = [
  'clinic.medical_records.view',
  'clinic.medical_records.create',
  'clinic.medical_records.update',
  'clinic.prescriptions.manage',
  'clinic.consultations.start',
];

describe('permission catalog', () => {
  it('maps every role only to permissions of its own scope', () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(permissionScope(permission), `${role} → ${permission}`).toBe(
          ROLES[role as keyof typeof ROLES].scope,
        );
      }
    }
  });

  it('has no duplicate grants and only known permissions', () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      expect(new Set(permissions).size).toBe(permissions.length);
      for (const permission of permissions)
        expect(Object.hasOwn(PERMISSIONS, permission)).toBe(true);
    }
  });

  it('gives clinical permissions to doctors only', () => {
    for (const role of CLINIC_ROLES) {
      const clinical = ROLE_PERMISSIONS[role].filter((p) => CLINICAL.includes(p));
      expect(clinical.length > 0, role).toBe(role === 'DOCTOR');
    }
  });

  it('never lets a role assign itself or a more privileged role', () => {
    expect(ASSIGNABLE_CLINIC_ROLES.CLINIC_MANAGER).not.toContain('CLINIC_MANAGER');
    expect(ASSIGNABLE_CLINIC_ROLES.CLINIC_MANAGER).not.toContain('CLINIC_OWNER');
    expect(ASSIGNABLE_CLINIC_ROLES.CLINIC_OWNER).not.toContain('CLINIC_OWNER');
    expect(ASSIGNABLE_CLINIC_ROLES.DOCTOR).toEqual([]);
    expect(ASSIGNABLE_CLINIC_ROLES.RECEPTIONIST).toEqual([]);
  });

  it('defines every permission category requested for Task 02', () => {
    const required = [
      'settings.manage',
      'memberships.manage',
      'branches.manage',
      'doctors.manage',
      'services.manage',
      'schedules.manage',
      'bookings.view',
      'bookings.manage',
      'queue.manage',
      'consultations.start',
      'medical_records.view',
      'medical_records.create',
      'medical_records.update',
      'prescriptions.manage',
      'payments.manage',
      'reports.view',
      'data.export',
    ];
    for (const suffix of required)
      expect(Object.hasOwn(PERMISSIONS, `clinic.${suffix}`), suffix).toBe(true);
  });

  it('assigns an operation category and level to every clinic permission', () => {
    for (const [code, def] of Object.entries(PERMISSIONS) as [
      string,
      { scope: string; category?: string; level?: string },
    ][]) {
      if (def.scope !== 'CLINIC') continue;
      expect(def.category, code).toBeDefined();
      expect(def.level, code).toBeDefined();
    }
  });
});
