-- Migration: create_clinic_memberships
-- A user's role in one clinic. One row per (clinic, user, role): a user can hold several roles
-- in one clinic and memberships in many clinics. Rows are never deleted on termination
-- (status = TERMINATED); history lives in clinic_membership_events.
-- branch_scope: ALL = every branch of the clinic; ASSIGNED = only clinic_membership_branches.

CREATE TABLE clinic_memberships (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clinic_id          BIGINT UNSIGNED NOT NULL,
  user_id            BIGINT UNSIGNED NOT NULL,
  role_code          VARCHAR(32) NOT NULL,
  role_scope         VARCHAR(16) NOT NULL DEFAULT 'CLINIC',
  status             VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  branch_scope       VARCHAR(16) NOT NULL DEFAULT 'ASSIGNED',
  effective_from     DATETIME(3) NULL,
  effective_until    DATETIME(3) NULL,
  activated_at       DATETIME(3) NULL,
  terminated_at      DATETIME(3) NULL,
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clinic_memberships_clinic_user_role (clinic_id, user_id, role_code),
  UNIQUE KEY uq_clinic_memberships_id_clinic (id, clinic_id),
  KEY ix_clinic_memberships_user_status (user_id, status),
  KEY ix_clinic_memberships_clinic_status (clinic_id, status),
  CONSTRAINT fk_clinic_memberships_clinic FOREIGN KEY (clinic_id) REFERENCES clinics (id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinic_memberships_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_clinic_memberships_role FOREIGN KEY (role_code, role_scope) REFERENCES roles (code, scope),
  CONSTRAINT fk_clinic_memberships_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_clinic_memberships_role_scope CHECK (role_scope = 'CLINIC'),
  CONSTRAINT ck_clinic_memberships_status CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
  CONSTRAINT ck_clinic_memberships_branch_scope CHECK (branch_scope IN ('ALL', 'ASSIGNED')),
  CONSTRAINT ck_clinic_memberships_effective CHECK (
    effective_from IS NULL OR effective_until IS NULL OR effective_until > effective_from
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
