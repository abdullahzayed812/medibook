-- Migration: add_clinic_setup_permissions
-- Task 04. Two read permissions (writes reuse clinic.doctors.manage, clinic.services.manage and
-- clinic.schedules.manage). Must stay in sync with src/modules/access/authorization/catalog.ts.
-- No existing grant is changed.

INSERT INTO permissions (code, scope, description) VALUES
  ('clinic.services.view',  'CLINIC', 'View services, branch offerings and doctor-service assignments'),
  ('clinic.schedules.view', 'CLINIC', 'View doctor assignments, branch hours, schedules and exceptions');

INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES
  ('CLINIC_OWNER',   'CLINIC', 'clinic.services.view',  'CLINIC'),
  ('CLINIC_OWNER',   'CLINIC', 'clinic.schedules.view', 'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.services.view',  'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.schedules.view', 'CLINIC'),
  ('DOCTOR',         'CLINIC', 'clinic.services.view',  'CLINIC'),
  ('DOCTOR',         'CLINIC', 'clinic.schedules.view', 'CLINIC'),
  ('RECEPTIONIST',   'CLINIC', 'clinic.services.view',  'CLINIC'),
  ('RECEPTIONIST',   'CLINIC', 'clinic.schedules.view', 'CLINIC');
