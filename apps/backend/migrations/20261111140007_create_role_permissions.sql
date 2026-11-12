-- Migration: create_role_permissions
-- Role-to-permission mapping (runtime source of truth). Scope columns + CHECK guarantee at the
-- database level that clinic roles only get clinic permissions, platform roles only platform
-- permissions, and the patient role only patient (self) permissions.
-- Reviewable copy: docs/architecture/AUTHORIZATION.md and catalog.ts (sync verified by tests).

CREATE TABLE role_permissions (
  role_code        VARCHAR(32) NOT NULL,
  role_scope       VARCHAR(16) NOT NULL,
  permission_code  VARCHAR(64) NOT NULL,
  permission_scope VARCHAR(16) NOT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (role_code, permission_code),
  KEY ix_role_permissions_permission (permission_code),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_code, role_scope) REFERENCES roles (code, scope),
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_code, permission_scope) REFERENCES permissions (code, scope),
  CONSTRAINT ck_role_permissions_scope CHECK (role_scope = permission_scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES
  ('SUPER_ADMIN', 'PLATFORM', 'platform.users.view',           'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.users.manage_status',  'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.clinics.view',         'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.clinics.manage',       'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.memberships.manage',   'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.security_events.view', 'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.audit_events.view',    'PLATFORM'),

  ('CLINIC_OWNER', 'CLINIC', 'clinic.settings.manage',    'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.memberships.view',   'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.memberships.manage', 'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.branches.manage',    'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.doctors.manage',     'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.services.manage',    'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.schedules.manage',   'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.patients.view',      'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.patients.manage',    'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.bookings.view',      'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.bookings.manage',    'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.queue.manage',       'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.payments.manage',    'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.reports.view',       'CLINIC'),
  ('CLINIC_OWNER', 'CLINIC', 'clinic.data.export',        'CLINIC'),

  ('CLINIC_MANAGER', 'CLINIC', 'clinic.memberships.view',   'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.memberships.manage', 'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.doctors.manage',     'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.services.manage',    'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.schedules.manage',   'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.patients.view',      'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.patients.manage',    'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.bookings.view',      'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.bookings.manage',    'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.queue.manage',       'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.payments.manage',    'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.reports.view',       'CLINIC'),

  ('DOCTOR', 'CLINIC', 'clinic.patients.view',          'CLINIC'),
  ('DOCTOR', 'CLINIC', 'clinic.bookings.view',          'CLINIC'),
  ('DOCTOR', 'CLINIC', 'clinic.queue.manage',           'CLINIC'),
  ('DOCTOR', 'CLINIC', 'clinic.consultations.start',    'CLINIC'),
  ('DOCTOR', 'CLINIC', 'clinic.medical_records.view',   'CLINIC'),
  ('DOCTOR', 'CLINIC', 'clinic.medical_records.create', 'CLINIC'),
  ('DOCTOR', 'CLINIC', 'clinic.medical_records.update', 'CLINIC'),
  ('DOCTOR', 'CLINIC', 'clinic.prescriptions.manage',   'CLINIC'),

  ('RECEPTIONIST', 'CLINIC', 'clinic.patients.view',   'CLINIC'),
  ('RECEPTIONIST', 'CLINIC', 'clinic.patients.manage', 'CLINIC'),
  ('RECEPTIONIST', 'CLINIC', 'clinic.bookings.view',   'CLINIC'),
  ('RECEPTIONIST', 'CLINIC', 'clinic.bookings.manage', 'CLINIC'),
  ('RECEPTIONIST', 'CLINIC', 'clinic.queue.manage',    'CLINIC'),
  ('RECEPTIONIST', 'CLINIC', 'clinic.payments.manage', 'CLINIC'),

  ('PATIENT', 'PATIENT', 'patient.profile.view_own',    'PATIENT'),
  ('PATIENT', 'PATIENT', 'patient.bookings.view_own',   'PATIENT'),
  ('PATIENT', 'PATIENT', 'patient.bookings.manage_own', 'PATIENT');
