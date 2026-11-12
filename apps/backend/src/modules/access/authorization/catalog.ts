/**
 * Role & permission catalog — the reviewable definition of who may do what.
 *
 * Runtime authorization reads `role_permissions` from MySQL (so changes apply immediately); the
 * seed migrations must mirror this file exactly. An integration test fails if they diverge.
 * To change the mapping: edit this file AND add a migration, then update
 * docs/security/AUTHORIZATION.md.
 */

export type Scope = 'PLATFORM' | 'CLINIC' | 'PATIENT';

/**
 * For CLINIC permissions:
 * - CLINIC level: clinic-wide administration. Requires a membership with branch_scope = ALL.
 * - BRANCH level: day-to-day operations. Requires branch_scope = ALL, or (with a selected branch)
 *   a membership assigned to that branch.
 */
export type PermissionLevel = 'CLINIC' | 'BRANCH' | 'MEMBER';

/**
 * Operation category of a CLINIC permission. The clinic operation gate (clinic lifecycle,
 * suspension, closure and subscription state) allows or blocks whole categories, so enforcement
 * is centralized and applies to every route/service that asks the AuthorizationService.
 *   CLINIC_INFO         clinic profile, branches, subscription, staff list (always readable)
 *   READ                existing operational data (patients, bookings, reports, exports)
 *   CONTINUITY_OF_CARE  completing care for existing patients (queue, records, prescriptions, payments)
 *   ADMINISTRATION      changing configuration and staff
 *   NEW_OPERATION       creating new operational transactions (new patients, bookings)
 *   LIFECYCLE           closure requests and ownership transfer
 */
export type OperationCategory =
  'CLINIC_INFO' | 'READ' | 'CONTINUITY_OF_CARE' | 'ADMINISTRATION' | 'NEW_OPERATION' | 'LIFECYCLE';

interface PermissionDefinition {
  readonly scope: Scope;
  readonly level?: PermissionLevel;
  readonly category?: OperationCategory;
  readonly description: string;
}

type C = OperationCategory;
const clinic = (level: PermissionLevel, category: C, description: string) =>
  ({ scope: 'CLINIC', level, category, description }) as const;
const platform = (description: string) => ({ scope: 'PLATFORM', description }) as const;
const patient = (description: string) => ({ scope: 'PATIENT', description }) as const;

export const PERMISSIONS = {
  // Platform (SUPER_ADMIN; always requires an MFA-verified session)
  'platform.users.view': platform('View user accounts'),
  'platform.users.manage_status': platform('Suspend and reactivate user accounts'),
  'platform.clinics.view': platform('View clinics'),
  'platform.clinics.manage': platform(
    'Suspend, reinstate and close clinics; grant access exceptions',
  ),
  'platform.memberships.manage': platform('Manage clinic memberships of any clinic'),
  'platform.security_events.view': platform('View security events'),
  'platform.audit_events.view': platform('View audit events'),
  'platform.registrations.review': platform('Review, approve and reject clinic registrations'),
  'platform.doctors.verify': platform('Review doctor professional verification'),
  'platform.specialties.manage': platform('Manage the specialty catalog'),
  'platform.plans.manage': platform('Manage subscription plans'),
  'platform.subscriptions.manage': platform('Manage clinic subscriptions'),
  'platform.settings.manage': platform('Manage platform settings'),
  'platform.ownership.review': platform('Review clinic ownership transfers'),
  'platform.identity.resolve': platform('Resolve booking identity ownership cases'),

  // Clinic-wide information (MEMBER level: any covering membership, no branch needed)
  'clinic.profile.view': clinic('MEMBER', 'CLINIC_INFO', 'View clinic profile and status'),
  'clinic.branches.view': clinic('MEMBER', 'CLINIC_INFO', 'View branches'),
  // Task 04 reads: configuration, not patient data (CLINIC_INFO stays readable in every state).
  // Branch offerings additionally require coverage of the branch (path branch is re-resolved).
  'clinic.services.view': clinic(
    'MEMBER',
    'CLINIC_INFO',
    'View services, branch offerings and doctor-service assignments',
  ),
  'clinic.schedules.view': clinic(
    'BRANCH',
    'CLINIC_INFO',
    'View doctor assignments, branch hours, schedules and exceptions',
  ),

  // Clinic administration (CLINIC level: requires branch_scope = ALL)
  'clinic.settings.manage': clinic('CLINIC', 'ADMINISTRATION', 'Manage clinic settings'),
  'clinic.profile.manage': clinic('CLINIC', 'ADMINISTRATION', 'Edit clinic profile'),
  'clinic.memberships.view': clinic('CLINIC', 'CLINIC_INFO', 'View clinic memberships'),
  'clinic.memberships.manage': clinic('CLINIC', 'ADMINISTRATION', 'Manage clinic memberships'),
  'clinic.branches.manage': clinic('CLINIC', 'ADMINISTRATION', 'Manage branches'),
  'clinic.doctors.manage': clinic('CLINIC', 'ADMINISTRATION', 'Manage doctors'),
  'clinic.services.manage': clinic('CLINIC', 'ADMINISTRATION', 'Manage services'),
  'clinic.data.export': clinic('CLINIC', 'READ', 'Export permitted data'),
  'clinic.subscription.view': clinic('CLINIC', 'CLINIC_INFO', 'View subscription and history'),
  'clinic.marketplace.manage': clinic('CLINIC', 'ADMINISTRATION', 'Manage marketplace visibility'),
  'clinic.lifecycle.manage': clinic(
    'CLINIC',
    'LIFECYCLE',
    'Request closure and ownership transfer',
  ),

  // Clinic operations (BRANCH level)
  'clinic.schedules.manage': clinic('BRANCH', 'ADMINISTRATION', 'Manage schedules'),
  'clinic.patients.view': clinic('BRANCH', 'READ', 'View clinic patient profiles'),
  'clinic.patients.manage': clinic(
    'BRANCH',
    'NEW_OPERATION',
    'Create and update clinic patient profiles',
  ),
  'clinic.bookings.view': clinic('BRANCH', 'READ', 'View bookings'),
  'clinic.bookings.manage': clinic('BRANCH', 'NEW_OPERATION', 'Manage bookings'),
  // Task 05: rejecting/cancelling releases capacity; must work while new operations are blocked.
  'clinic.bookings.cancel': clinic(
    'BRANCH',
    'CONTINUITY_OF_CARE',
    'Reject booking requests and cancel bookings',
  ),
  'clinic.queue.manage': clinic('BRANCH', 'CONTINUITY_OF_CARE', 'Manage the patient queue'),
  'clinic.consultations.start': clinic('BRANCH', 'CONTINUITY_OF_CARE', 'Start consultations'),
  'clinic.medical_records.view': clinic('BRANCH', 'CONTINUITY_OF_CARE', 'View medical records'),
  'clinic.medical_records.create': clinic('BRANCH', 'CONTINUITY_OF_CARE', 'Create medical records'),
  'clinic.medical_records.update': clinic(
    'BRANCH',
    'CONTINUITY_OF_CARE',
    'Update medical records according to policy',
  ),
  'clinic.prescriptions.manage': clinic('BRANCH', 'CONTINUITY_OF_CARE', 'Manage prescriptions'),
  'clinic.payments.manage': clinic('BRANCH', 'CONTINUITY_OF_CARE', 'Manage payments'),
  'clinic.reports.view': clinic('BRANCH', 'READ', 'View reports'),

  // Patient self-service (ownership checks apply to every target resource)
  'patient.profile.view_own': patient('View own patient profiles'),
  'patient.bookings.view_own': patient('View own bookings'),
  'patient.bookings.manage_own': patient('Create and cancel own bookings'),
} as const satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof PERMISSIONS;

export const ROLES = {
  SUPER_ADMIN: { scope: 'PLATFORM' },
  CLINIC_OWNER: { scope: 'CLINIC' },
  CLINIC_MANAGER: { scope: 'CLINIC' },
  DOCTOR: { scope: 'CLINIC' },
  RECEPTIONIST: { scope: 'CLINIC' },
  PATIENT: { scope: 'PATIENT' },
} as const satisfies Record<string, { scope: Scope }>;

export type Role = keyof typeof ROLES;
export type ClinicRole = 'CLINIC_OWNER' | 'CLINIC_MANAGER' | 'DOCTOR' | 'RECEPTIONIST';
export const CLINIC_ROLES: readonly ClinicRole[] = [
  'CLINIC_OWNER',
  'CLINIC_MANAGER',
  'DOCTOR',
  'RECEPTIONIST',
];

/** Mirror of the seeded role_permissions rows. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  SUPER_ADMIN: [
    'platform.users.view',
    'platform.users.manage_status',
    'platform.clinics.view',
    'platform.clinics.manage',
    'platform.memberships.manage',
    'platform.security_events.view',
    'platform.audit_events.view',
    'platform.registrations.review',
    'platform.doctors.verify',
    'platform.specialties.manage',
    'platform.plans.manage',
    'platform.subscriptions.manage',
    'platform.settings.manage',
    'platform.ownership.review',
    'platform.identity.resolve',
  ],
  // Business administration; deliberately NO clinical permissions (records, prescriptions,
  // consultations). An owner who is also a doctor gets those through a DOCTOR membership.
  CLINIC_OWNER: [
    'clinic.settings.manage',
    'clinic.memberships.view',
    'clinic.memberships.manage',
    'clinic.branches.manage',
    'clinic.doctors.manage',
    'clinic.services.manage',
    'clinic.schedules.manage',
    'clinic.patients.view',
    'clinic.patients.manage',
    'clinic.bookings.view',
    'clinic.bookings.manage',
    'clinic.queue.manage',
    'clinic.payments.manage',
    'clinic.reports.view',
    'clinic.data.export',
    'clinic.profile.view',
    'clinic.profile.manage',
    'clinic.branches.view',
    'clinic.subscription.view',
    'clinic.marketplace.manage',
    'clinic.lifecycle.manage',
    'clinic.services.view',
    'clinic.schedules.view',
    'clinic.bookings.cancel',
  ],
  CLINIC_MANAGER: [
    'clinic.memberships.view',
    'clinic.memberships.manage',
    'clinic.doctors.manage',
    'clinic.services.manage',
    'clinic.schedules.manage',
    'clinic.patients.view',
    'clinic.patients.manage',
    'clinic.bookings.view',
    'clinic.bookings.manage',
    'clinic.queue.manage',
    'clinic.payments.manage',
    'clinic.reports.view',
    'clinic.profile.view',
    'clinic.branches.view',
    'clinic.services.view',
    'clinic.schedules.view',
    'clinic.bookings.cancel',
  ],
  DOCTOR: [
    'clinic.patients.view',
    'clinic.bookings.view',
    'clinic.queue.manage',
    'clinic.consultations.start',
    'clinic.medical_records.view',
    'clinic.medical_records.create',
    'clinic.medical_records.update',
    'clinic.prescriptions.manage',
    'clinic.profile.view',
    'clinic.branches.view',
    'clinic.services.view',
    'clinic.schedules.view',
  ],
  RECEPTIONIST: [
    'clinic.patients.view',
    'clinic.patients.manage',
    'clinic.bookings.view',
    'clinic.bookings.manage',
    'clinic.queue.manage',
    'clinic.payments.manage',
    'clinic.profile.view',
    'clinic.branches.view',
    'clinic.services.view',
    'clinic.schedules.view',
    'clinic.bookings.cancel',
  ],
  PATIENT: ['patient.profile.view_own', 'patient.bookings.view_own', 'patient.bookings.manage_own'],
};

/**
 * Which clinic roles a holder of each clinic role may grant, change or terminate (in addition to
 * holding `clinic.memberships.manage`). Nobody may change their own memberships. Granting or
 * terminating CLINIC_OWNER requires `platform.memberships.manage`.
 */
export const ASSIGNABLE_CLINIC_ROLES: Readonly<Record<ClinicRole, readonly ClinicRole[]>> = {
  CLINIC_OWNER: ['CLINIC_MANAGER', 'DOCTOR', 'RECEPTIONIST'],
  CLINIC_MANAGER: ['DOCTOR', 'RECEPTIONIST'],
  DOCTOR: [],
  RECEPTIONIST: [],
};

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

export function permissionScope(permission: Permission): Scope {
  return PERMISSIONS[permission].scope;
}

export function permissionLevel(permission: Permission): PermissionLevel {
  const definition: PermissionDefinition = PERMISSIONS[permission];
  return definition.level ?? 'CLINIC';
}

export function isClinicRole(value: string): value is ClinicRole {
  return (CLINIC_ROLES as readonly string[]).includes(value);
}

export function permissionCategory(permission: Permission): OperationCategory {
  const definition: PermissionDefinition = PERMISSIONS[permission];
  return definition.category ?? 'ADMINISTRATION';
}
