import { describe, expect, it } from 'vitest';
import type { ActiveMembership } from '../tenancy/memberships.repository.js';
import { ROLE_PERMISSIONS } from './catalog.js';
import { evaluateClinicPermission } from './evaluate.js';

const rolePermissions = new Map(
  Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [role, new Set<string>(perms)]),
);

const m = (
  role: ActiveMembership['role'],
  branchScope: 'ALL' | 'ASSIGNED',
  branchIds: string[] = [],
): ActiveMembership => ({
  id: '1',
  role,
  branchScope,
  branchIds,
});

const evaluate = (
  memberships: ActiveMembership[],
  permission: Parameters<typeof evaluateClinicPermission>[0]['permission'],
  branchId: string | null = null,
) => evaluateClinicPermission({ memberships, rolePermissions, permission, branchId });

describe('evaluateClinicPermission', () => {
  it('grants role permissions to all-branch members', () => {
    expect(evaluate([m('RECEPTIONIST', 'ALL')], 'clinic.bookings.manage')).toEqual({
      allowed: true,
    });
    expect(evaluate([m('RECEPTIONIST', 'ALL')], 'clinic.bookings.manage', '9')).toEqual({
      allowed: true,
    });
  });

  it('denies permissions the role does not have', () => {
    expect(evaluate([m('RECEPTIONIST', 'ALL')], 'clinic.medical_records.view')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
    expect(evaluate([m('CLINIC_OWNER', 'ALL')], 'clinic.medical_records.view')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
    expect(evaluate([], 'clinic.bookings.view')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
  });

  it('requires a selected, assigned branch for branch-assigned members', () => {
    const doctor = [m('DOCTOR', 'ASSIGNED', ['5'])];
    expect(evaluate(doctor, 'clinic.medical_records.view')).toEqual({
      allowed: false,
      reason: 'BRANCH_CONTEXT_REQUIRED',
    });
    expect(evaluate(doctor, 'clinic.medical_records.view', '5')).toEqual({ allowed: true });
    expect(evaluate(doctor, 'clinic.medical_records.view', '6')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
  });

  it('never grants CLINIC-level permissions through branch-assigned memberships', () => {
    expect(
      evaluate([m('CLINIC_MANAGER', 'ASSIGNED', ['5'])], 'clinic.memberships.manage', '5'),
    ).toEqual({ allowed: false, reason: 'NO_PERMISSION' });
    expect(evaluate([m('CLINIC_MANAGER', 'ALL')], 'clinic.memberships.manage')).toEqual({
      allowed: true,
    });
  });

  it('only counts memberships whose role holds the permission', () => {
    // Receptionist for all branches + doctor at branch 5: clinical access only at branch 5.
    const memberships = [m('RECEPTIONIST', 'ALL'), m('DOCTOR', 'ASSIGNED', ['5'])];
    expect(evaluate(memberships, 'clinic.prescriptions.manage', '6')).toEqual({
      allowed: false,
      reason: 'NO_PERMISSION',
    });
    expect(evaluate(memberships, 'clinic.prescriptions.manage', '5')).toEqual({ allowed: true });
    expect(evaluate(memberships, 'clinic.bookings.view', '6')).toEqual({ allowed: true });
  });

  it('reflects changes in the role-permission mapping immediately', () => {
    const changed = new Map(rolePermissions);
    changed.set('RECEPTIONIST', new Set(['clinic.bookings.view']));
    expect(
      evaluateClinicPermission({
        memberships: [m('RECEPTIONIST', 'ALL')],
        rolePermissions: changed,
        permission: 'clinic.bookings.manage',
        branchId: null,
      }).allowed,
    ).toBe(false);
  });
});
