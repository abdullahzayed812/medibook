-- Migration: create_user_global_roles
-- Account-level (non-clinic) roles: SUPER_ADMIN and PATIENT. Clinic roles can never be stored
-- here (CHECK + composite FK on scope); they live in clinic_memberships.

CREATE TABLE user_global_roles (
  user_id            BIGINT UNSIGNED NOT NULL,
  role_code          VARCHAR(32) NOT NULL,
  role_scope         VARCHAR(16) NOT NULL,
  granted_by_user_id BIGINT UNSIGNED NULL,
  granted_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, role_code),
  KEY ix_user_global_roles_role (role_code),
  CONSTRAINT fk_user_global_roles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_global_roles_role FOREIGN KEY (role_code, role_scope) REFERENCES roles (code, scope),
  CONSTRAINT fk_user_global_roles_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_user_global_roles_scope CHECK (role_scope IN ('PLATFORM', 'PATIENT'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
