-- Migration: create_roles
-- Fixed system roles (no user-defined roles). scope separates platform, clinic and patient roles.
-- Must stay in sync with src/modules/access/authorization/catalog.ts (verified by tests).

CREATE TABLE roles (
  code        VARCHAR(32)  NOT NULL,
  scope       VARCHAR(16)  NOT NULL,
  description VARCHAR(255) NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  UNIQUE KEY uq_roles_code_scope (code, scope),
  CONSTRAINT ck_roles_scope CHECK (scope IN ('PLATFORM', 'CLINIC', 'PATIENT'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO roles (code, scope, description) VALUES
  ('SUPER_ADMIN',    'PLATFORM', 'Platform super administrator (2FA mandatory)'),
  ('CLINIC_OWNER',   'CLINIC',   'Owner of a clinic'),
  ('CLINIC_MANAGER', 'CLINIC',   'Manager of a clinic'),
  ('DOCTOR',         'CLINIC',   'Doctor working at a clinic'),
  ('RECEPTIONIST',   'CLINIC',   'Receptionist at a clinic'),
  ('PATIENT',        'PATIENT',  'Patient (self-service access to own data)');
