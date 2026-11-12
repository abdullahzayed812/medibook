-- Migration: add_booking_permissions
-- Task 05. Rejecting and cancelling bookings releases capacity and is part of continuity of
-- care, so it must stay possible when new operations are restricted (ADR-026). The existing
-- clinic.bookings.manage (NEW_OPERATION) remains the confirm permission. Must stay in sync with
-- src/modules/access/authorization/catalog.ts. No existing grant is changed.

INSERT INTO permissions (code, scope, description) VALUES
  ('clinic.bookings.cancel', 'CLINIC', 'Reject booking requests and cancel bookings');

INSERT INTO role_permissions (role_code, role_scope, permission_code, permission_scope) VALUES
  ('CLINIC_OWNER',   'CLINIC', 'clinic.bookings.cancel', 'CLINIC'),
  ('CLINIC_MANAGER', 'CLINIC', 'clinic.bookings.cancel', 'CLINIC'),
  ('RECEPTIONIST',   'CLINIC', 'clinic.bookings.cancel', 'CLINIC');
