-- Migration: add_identity_permission
-- Task 05.1. Super Admin resolution of identity support cases. Must stay in sync with
-- src/modules/access/authorization/catalog.ts. No existing grant is changed.

INSERT INTO permissions (code, scope, description) VALUES
  ('platform.identity.resolve', 'PLATFORM', 'Resolve booking identity ownership cases');

INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES
  ('SUPER_ADMIN', 'PLATFORM', 'platform.identity.resolve', 'PLATFORM');
