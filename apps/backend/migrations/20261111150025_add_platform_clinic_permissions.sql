-- Migration: add_platform_clinic_permissions
-- Task 03 permissions. Must stay in sync with src/modules/access/authorization/catalog.ts.
-- No existing role grant is changed.
-- Task 03.1: platform.specialties.manage was folded into this (unreleased) migration rather than
-- added as a new file; see docs/development/DATABASE_MIGRATIONS.md (development-phase policy).

INSERT INTO permissions (code, scope, description) VALUES
  ('platform.registrations.review', 'PLATFORM', 'Review, approve and reject clinic registrations'),
  ('platform.doctors.verify',       'PLATFORM', 'Review doctor professional verification'),
  ('platform.specialties.manage',   'PLATFORM', 'Manage the specialty catalog'),
  ('platform.plans.manage',         'PLATFORM', 'Manage subscription plans'),
  ('platform.subscriptions.manage', 'PLATFORM', 'Manage clinic subscriptions'),
  ('platform.settings.manage',      'PLATFORM', 'Manage platform settings'),
  ('platform.ownership.review',     'PLATFORM', 'Review clinic ownership transfers'),
  ('clinic.profile.view',           'CLINIC',   'View clinic profile and status'),
  ('clinic.profile.manage',         'CLINIC',   'Edit clinic profile'),
  ('clinic.branches.view',          'CLINIC',   'View branches'),
  ('clinic.subscription.view',      'CLINIC',   'View subscription and history'),
  ('clinic.marketplace.manage',     'CLINIC',   'Manage marketplace visibility'),
  ('clinic.lifecycle.manage',       'CLINIC',   'Request closure and ownership transfer');

INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES
  ('SUPER_ADMIN', 'PLATFORM', 'platform.registrations.review', 'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.doctors.verify',       'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.specialties.manage',   'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.plans.manage',         'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.subscriptions.manage', 'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.settings.manage',      'PLATFORM'),
  ('SUPER_ADMIN', 'PLATFORM', 'platform.ownership.review',     'PLATFORM'),

  ('CLINIC_OWNER',   'CLINIC', 'clinic.profile.view',       'CLINIC'),
  ('CLINIC_OWNER',   'CLINIC', 'clinic.profile.manage',     'CLINIC'),
  ('CLINIC_OWNER',   'CLINIC', 'clinic.branches.view',      'CLINIC'),
  ('CLINIC_OWNER',   'CLINIC', 'clinic.subscription.view',  'CLINIC'),
  ('CLINIC_OWNER',   'CLINIC', 'clinic.marketplace.manage', 'CLINIC'),
  ('CLINIC_OWNER',   'CLINIC', 'clinic.lifecycle.manage',   'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.profile.view',       'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.branches.view',      'CLINIC'),
  ('DOCTOR',         'CLINIC', 'clinic.profile.view',       'CLINIC'),
  ('DOCTOR',         'CLINIC', 'clinic.branches.view',      'CLINIC'),
  ('RECEPTIONIST',   'CLINIC', 'clinic.profile.view',       'CLINIC'),
  ('RECEPTIONIST',   'CLINIC', 'clinic.branches.view',      'CLINIC');
