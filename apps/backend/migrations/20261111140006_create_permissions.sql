-- Migration: create_permissions
-- Permission catalog. Must stay in sync with src/modules/access/authorization/catalog.ts.

CREATE TABLE permissions (
  code        VARCHAR(64)  NOT NULL,
  scope       VARCHAR(16)  NOT NULL,
  description VARCHAR(255) NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  UNIQUE KEY uq_permissions_code_scope (code, scope),
  CONSTRAINT ck_permissions_scope CHECK (scope IN ('PLATFORM', 'CLINIC', 'PATIENT'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO permissions (code, scope, description) VALUES
  ('platform.users.view',            'PLATFORM', 'View user accounts'),
  ('platform.users.manage_status',   'PLATFORM', 'Suspend and reactivate user accounts'),
  ('platform.clinics.view',          'PLATFORM', 'View clinics'),
  ('platform.clinics.manage',        'PLATFORM', 'Manage clinics'),
  ('platform.memberships.manage',    'PLATFORM', 'Manage clinic memberships of any clinic'),
  ('platform.security_events.view',  'PLATFORM', 'View security events'),
  ('platform.audit_events.view',     'PLATFORM', 'View audit events'),
  ('clinic.settings.manage',         'CLINIC',   'Manage clinic settings'),
  ('clinic.memberships.view',        'CLINIC',   'View clinic memberships'),
  ('clinic.memberships.manage',      'CLINIC',   'Manage clinic memberships (subject to role assignment rules)'),
  ('clinic.branches.manage',         'CLINIC',   'Manage branches'),
  ('clinic.doctors.manage',          'CLINIC',   'Manage doctors'),
  ('clinic.services.manage',         'CLINIC',   'Manage services'),
  ('clinic.schedules.manage',        'CLINIC',   'Manage schedules'),
  ('clinic.patients.view',           'CLINIC',   'View clinic patient profiles'),
  ('clinic.patients.manage',         'CLINIC',   'Create and update clinic patient profiles'),
  ('clinic.bookings.view',           'CLINIC',   'View bookings'),
  ('clinic.bookings.manage',         'CLINIC',   'Manage bookings'),
  ('clinic.queue.manage',            'CLINIC',   'Manage the patient queue'),
  ('clinic.consultations.start',     'CLINIC',   'Start consultations'),
  ('clinic.medical_records.view',    'CLINIC',   'View medical records'),
  ('clinic.medical_records.create',  'CLINIC',   'Create medical records'),
  ('clinic.medical_records.update',  'CLINIC',   'Update medical records according to policy'),
  ('clinic.prescriptions.manage',    'CLINIC',   'Manage prescriptions'),
  ('clinic.payments.manage',         'CLINIC',   'Manage payments'),
  ('clinic.reports.view',            'CLINIC',   'View reports'),
  ('clinic.data.export',             'CLINIC',   'Export permitted data'),
  ('patient.profile.view_own',       'PATIENT',  'View own patient profiles'),
  ('patient.bookings.view_own',      'PATIENT',  'View own bookings'),
  ('patient.bookings.manage_own',    'PATIENT',  'Create and cancel own bookings');
